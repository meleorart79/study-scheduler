import { configSchema } from "./schema.js";
import type { Config } from "../types.js";
import type { Repository } from "../state/repository.js";
import type { Logger } from "../logging/logger.js";

const RUNTIME_CONFIG_KEY = "runtime_config";

export class ConfigHolder {
    private current: Config;

    constructor(
        private fileConfig: Config,
        private repo: Repository,
        private logger?: Logger
    ) {
        const stored = repo.getKv(RUNTIME_CONFIG_KEY);
        if (stored) {
            let parsedJson: unknown;
            try {
                parsedJson = JSON.parse(stored);
            } catch (err) {
                // Previously unguarded: a corrupted kv row would throw here and
                // crash startup entirely instead of falling back like an
                // invalid-but-parseable value does below.
                this.logger?.warn(
                    { err: (err as Error).message },
                    "Persisted runtime config is not valid JSON; falling back to file config"
                );
                this.current = fileConfig;
                return;
            }
            const parsed = configSchema.safeParse(parsedJson);
            if (parsed.success) {
                this.current = parsed.data as Config;
            } else {
                this.logger?.warn(
                    { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
                    "Persisted runtime config failed schema validation; falling back to file config " +
                    "(any prior admin config change was silently dropped until re-applied)"
                );
                this.current = fileConfig;
            }
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