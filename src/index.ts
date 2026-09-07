import { loadConfig, loadFeedToken } from "./config/load.js";
import { ConfigHolder } from "./config/holder.js";
import { openDatabase } from "./state/db.js";
import { Repository } from "./state/repository.js";
import { buildServer } from "./http/server.js";
import { startCron } from "./cron/scheduler.js";
import { regenerate } from "./pipeline.js";
import { logger } from "./logging/logger.js";

async function main() {
  const configPath = process.env.STUDY_CONFIG_PATH ?? "./config/default.yaml";
  const dbPath = process.env.STUDY_DB_PATH ?? "./data/study-scheduler.db";
  const domain = process.env.STUDY_DOMAIN ?? "study-scheduler.local";
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";

  const feedToken = loadFeedToken();
  const adminToken = process.env.STUDY_ADMIN_TOKEN ?? feedToken;

  const fileConfig = loadConfig(configPath);
  const db = openDatabase(dbPath);
  const repo = new Repository(db);
  const configHolder = new ConfigHolder(fileConfig, repo);

  logger.info({ configPath, dbPath, domain }, "Starting study-scheduler");

  // Startup regeneration, using the same pipeline as cron/manual.
  const startupRun = await regenerate({ repo, configHolder, domain, logger }, "startup");
  logger.info({ runId: startupRun.id, status: startupRun.status }, "Startup regeneration finished");

  const cronJob = startCron({ repo, configHolder, domain, logger });

  const app = buildServer({ repo, configHolder, domain, logger, feedToken, adminToken });

  await app.listen({ port, host });
  logger.info({ port, host }, "HTTP server listening");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    cronJob.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.stack : err }, "Fatal startup error");
  process.exit(1);
});
