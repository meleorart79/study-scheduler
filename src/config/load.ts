import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { configSchema } from "./schema.js";
import type { Config } from "../types.js";

export class ConfigError extends Error {}

/**
 * Loads config from a YAML file, with a small number of environment
 * variable overrides for secrets/deployment-specific values that
 * shouldn't live in the checked-in YAML (feed URL/file, feed token).
 */
export function loadConfig(path: string): Config {
  if (!existsSync(path)) {
    throw new ConfigError(`Config file not found: ${path}`);
  }
  const raw = parseYaml(readFileSync(path, "utf8")) as unknown;

  const merged = mergeEnvOverrides(raw);

  const result = configSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(
      `Invalid configuration:\n${result.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`
    );
  }
  return result.data as Config;
}

function mergeEnvOverrides(raw: unknown): unknown {
  const obj = (
    typeof raw === "object" && raw !== null ? raw : {}
  ) as Record<string, any>;

  // STUDY_FEED_FILE takes precedence over STUDY_FEED_URL if both happen to
  // be set, and clears the other field so the schema's "exactly one of
  // url/file" refinement doesn't reject a leftover value from the YAML.
  if (process.env.STUDY_FEED_FILE) {
    obj.sourceFeed = {
      ...(obj.sourceFeed ?? {}),
      file: process.env.STUDY_FEED_FILE,
      url: undefined,
    };
  } else if (process.env.STUDY_FEED_URL) {
    obj.sourceFeed = {
      ...(obj.sourceFeed ?? {}),
      url: process.env.STUDY_FEED_URL,
      file: undefined,
    };
  }
  return obj;
}

/** The token clients must present to subscribe to the generated ICS feed. */
export function loadFeedToken(): string {
  const token = process.env.STUDY_FEED_TOKEN;
  if (!token || token.length < 16) {
    throw new ConfigError(
      "STUDY_FEED_TOKEN env var must be set to a random string of at least 16 characters"
    );
  }
  return token;
}
