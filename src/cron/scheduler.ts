import { Cron } from "croner";
import { regenerate } from "../pipeline.js";
import type { Repository } from "../state/repository.js";
import type { ConfigHolder } from "../config/holder.js";
import type { Logger } from "../logging/logger.js";

export function startCron(deps: {
  repo: Repository;
  configHolder: ConfigHolder;
  domain: string;
  logger: Logger;
}): Cron {
  const config = deps.configHolder.get();
  const [hh, mm] = config.regeneration.cronTime.split(":");
  const pattern = `${Number(mm)} ${Number(hh)} * * *`;

  const job = new Cron(
    pattern,
    { timezone: config.regeneration.cronTimezone },
    async () => {
      deps.logger.info("Cron-triggered regeneration starting");
      try {
        await regenerate(deps, "cron");
      } catch (err) {
        deps.logger.error({ err: (err as Error).message }, "Cron regeneration failed to even start");
      }
    }
  );

  deps.logger.info(
    { pattern, timezone: config.regeneration.cronTimezone, nextRun: job.nextRun()?.toISOString() },
    "Daily regeneration cron scheduled"
  );

  return job;
}
