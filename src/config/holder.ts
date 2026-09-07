import { configSchema } from "./schema.js";
import type { Config } from "../types.js";
import type { Repository } from "../state/repository.js";

const RUNTIME_CONFIG_KEY = "runtime_config";

export class ConfigHolder {
  private current: Config;

  constructor(
    private fileConfig: Config,
    private repo: Repository
  ) {
    const stored = repo.getKv(RUNTIME_CONFIG_KEY);
    if (stored) {
      const parsed = configSchema.safeParse(JSON.parse(stored));
      this.current = parsed.success ? (parsed.data as Config) : fileConfig;
    } else {
      this.current = fileConfig;
    }
  }

  get(): Config {
    return this.current;
  }

  /** Validates and persists a new effective config, returning it. */
  set(next: unknown): Config {
    const parsed = configSchema.parse(next) as Config;
    this.repo.setKv(RUNTIME_CONFIG_KEY, JSON.stringify(parsed));
    this.current = parsed;
    return parsed;
  }

  /** Reverts to the on-disk YAML config (clears any runtime override). */
  resetToFile(): Config {
    this.repo.setKv(RUNTIME_CONFIG_KEY, JSON.stringify(this.fileConfig));
    this.current = this.fileConfig;
    return this.current;
  }
}
