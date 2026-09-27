import { Cron } from "croner";
import { regenerate } from "../pipeline.js";
import type { Repository } from "../state/repository.js";
import type { ConfigHolder } from "../config/holder.js";
import type { Logger } from "../logging/logger.js";
import type { Config } from "../types.js";

export interface CronControl {
    /** Current underlying croner job (e.g. for `.stop()` on shutdown, `.nextRun()`). */
    readonly job: Cron;
    /**
     * Re-reads regeneration.cronTime/cronTimezone from configHolder and, if
     * either changed since the job was last (re)built, stops the current job
     * and starts a new one with the updated pattern. No-op otherwise.
     *
     * PUT /admin/config previously updated the persisted config but left the
     * already-running Cron job on its original startup-time pattern -- this
     * closes that gap. Call this after any config update that might touch
     * `regeneration`.
     */
    reschedule(): void;
}

function buildSpec(config: Config): { pattern: string; timezone: string } {
    const [hh, mm] = config.regeneration.cronTime.split(":");
    return { pattern: `${Number(mm)} ${Number(hh)} * * *`, timezone: config.regeneration.cronTimezone };
}

export function startCron(deps: {
    repo: Repository;
    configHolder: ConfigHolder;
    domain: string;
    logger: Logger;
}): CronControl {
    function createJob(spec: { pattern: string; timezone: string }): Cron {
        const j = new Cron(spec.pattern, { timezone: spec.timezone }, async () => {
            deps.logger.info("Cron-triggered regeneration starting");
            try {
                await regenerate(deps, "cron");
            } catch (err) {
                deps.logger.error({ err: (err as Error).message }, "Cron regeneration failed to even start");
            }
        });
        deps.logger.info(
            { pattern: spec.pattern, timezone: spec.timezone, nextRun: j.nextRun()?.toISOString() },
            "Daily regeneration cron scheduled"
        );
        return j;
    }

    let current = buildSpec(deps.configHolder.get());
    let job = createJob(current);

    return {
        get job() {
            return job;
        },
        reschedule() {
            const next = buildSpec(deps.configHolder.get());
            if (next.pattern === current.pattern && next.timezone === current.timezone) return;
            deps.logger.info({ from: current, to: next }, "Regeneration cron schedule changed; rescheduling");
            job.stop();
            current = next;
            job = createJob(current);
        },
    };
}