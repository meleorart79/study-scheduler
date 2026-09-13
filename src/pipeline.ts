import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fetchIcsFeed, readIcsFeedFromFile, FeedFetchError } from "./ics-input/fetch.js";
import { parseIcsFeed } from "./ics-input/parse.js";
import { normalizeSourceEvents } from "./normalization/normalize.js";
import { loadScheduleFile, AssessmentLoadError } from "./assessments/loadSchedule.js";
import { toDomainAssessments, computeExamBlackouts, computeHolidayPeriods } from "./assessments/blackout.js";
import { blockedPeriodsFromConfig, visibleCommitmentPeriods } from "./scheduling/blockedPeriods.js";
import { runScheduling } from "./scheduling/engine.js";
import { generateStudyIcs, generateSchoolIcs } from "./ics-output/generate.js";
import { localMidnightUtc, addDaysToDateString, localDateString } from "./util/timezone.js";
import type { RunTrigger, SchedulingRun } from "./types.js";
import type { Repository } from "./state/repository.js";
import type { Logger } from "./logging/logger.js";
import type { ConfigHolder } from "./config/holder.js";

export class ConcurrentRegenerationError extends Error {
  constructor() {
    super("A regeneration is already in progress");
  }
}

let regenerationInFlight = false;

export interface PipelineDeps {
  repo: Repository;
  configHolder: ConfigHolder;
  domain: string;
  logger: Logger;
}

export async function regenerate(deps: PipelineDeps, trigger: RunTrigger): Promise<SchedulingRun> {
  if (regenerationInFlight) {
    throw new ConcurrentRegenerationError();
  }
  regenerationInFlight = true;
  try {
    return await runOnce(deps, trigger);
  } finally {
    regenerationInFlight = false;
  }
}

async function runOnce(deps: PipelineDeps, trigger: RunTrigger): Promise<SchedulingRun> {
  const { repo, domain, logger } = deps;
  const config = deps.configHolder.get();
  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  const run: SchedulingRun = {
    id: runId,
    trigger,
    status: "RUNNING",
    startedAt,
    finishedAt: null,
    sourceFeedHash: null,
    sessionsScheduled: 0,
    sessionsNeedsAttention: 0,
    sessionsCancelled: 0,
    error: null,
  };
  repo.insertRun(run);

  try {
    // --- 1. Fetch feed (input only; never re-served/modified) ---
    // Either read a local .ics file (sourceFeed.file) or fetch a URL
    // (sourceFeed.url) -- the config schema guarantees exactly one is set.
    const feed = config.sourceFeed.file
      ? readIcsFeedFromFile(config.sourceFeed.file, config.sourceFeed.maxResponseBytes)
      : await fetchIcsFeed(
          config.sourceFeed.url!,
          config.sourceFeed.fetchTimeoutSeconds,
          config.sourceFeed.maxResponseBytes
        );

    // --- 2. Load schedule.js (sole source of truth for assessments) ---
    const schedule = loadScheduleFile(config.assessments.file);
    const scheduleFileHash = createHash("sha256")
      .update(readFileSync(config.assessments.file, "utf8"))
      .digest("hex");

    const overrides = repo.getAllOverrides();
    const signature = createHash("sha256")
      .update(feed.hash)
      .update(scheduleFileHash)
      .update(JSON.stringify(config))
      .update(JSON.stringify(overrides))
      .digest("hex");

    const lastSignature = repo.getKv("last_run_signature");
    if (lastSignature === signature && trigger !== "manual") {
      // Cheap no-op: nothing that could change the outcome has changed.
      // (Manual regenerations always run fully, so an operator-triggered
      // "regenerate now" is never silently skipped.)
      run.status = "NO_OP";
      run.finishedAt = new Date().toISOString();
      run.sourceFeedHash = signature;
      repo.updateRun(run);
      logger.info({ runId }, "Regeneration no-op: no relevant inputs changed");
      return run;
    }

    // --- 3. Parse + expand recurrence ---
    const today = localDateString(new Date(), config.timezone);
    const horizonStartDate = addDaysToDateString(today, -config.horizon.lookbackDays);
    const horizonEndDate = addDaysToDateString(today, config.horizon.lookaheadDays);
    const rangeStartUtc = localMidnightUtc(horizonStartDate, config.timezone);
    const rangeEndUtc = localMidnightUtc(addDaysToDateString(horizonEndDate, 1), config.timezone);

    const parseResult = parseIcsFeed(feed.text, {
      rangeStartUtc,
      rangeEndUtc,
      fallbackTimezone: config.timezone,
    });
    for (const w of parseResult.warnings) {
      logger.warn({ runId, uid: w.uid }, w.message);
    }

    // --- 4. Normalize into stable SourceEvents ---
    const prevSourceEvents = repo.getAllSourceEvents();
    const nowIso = new Date().toISOString();
    const sourceEvents = normalizeSourceEvents(
      parseResult.events,
      prevSourceEvents,
      nowIso,
      runId,
      logger
    );

    // --- 5. Assessments ---
    const assessments = toDomainAssessments(schedule.examSchedule);
    const examBlackouts = computeExamBlackouts(assessments, config);
    const holidayPeriods = computeHolidayPeriods(schedule.holidays);

    // --- 6. Scheduling engine (pure) ---
    const prevSessions = repo.getAllStudySessions();
    // Static + recurringBlockedPeriods (basketball), suppressed during exam
    // blackouts/holidays; holidayPeriods are also appended directly so they
    // block ALL scheduling (classes/study/basketball), not just basketball.
    const blockedPeriods = blockedPeriodsFromConfig(config, horizonStartDate, horizonEndDate, [
        ...examBlackouts,
        ...holidayPeriods,
    ]);

    const visibleCommitments = visibleCommitmentPeriods(config, horizonStartDate, horizonEndDate, [
        ...examBlackouts,
        ...holidayPeriods,
    ]);

    const output = runScheduling({
      sourceEvents,
      assessments,
      config,
      overrides,
      blockedPeriods,
      prevSessions,
      nowUtc: nowIso,
      runId,
    });

    // --- 7. Persist ---
    repo.replaceSourceEvents(sourceEvents);
    repo.replaceAssessmentsSnapshot(assessments, runId);
    repo.replaceStudySessions(output.sessions);
    repo.setKv("last_run_signature", signature);

    // --- 8. Generate both ICS feeds and cache each as "last known good" ---
    // Two independent feeds: the untouched school timetable, and the
    // generated study sessions. Kept as separate cached values (and thus
    // separate subscription URLs) so a failure/rebuild of one never
    // affects what's being served for the other.
    const studyIcs = generateStudyIcs(output.sessions, config, { domain }, visibleCommitments);
    repo.setKv("last_good_ics", studyIcs);
    repo.setKv("last_good_ics_generated_at", nowIso);

    const schoolIcs = generateSchoolIcs(sourceEvents, config, { domain });
    repo.setKv("last_good_school_ics", schoolIcs);
    repo.setKv("last_good_school_ics_generated_at", nowIso);

    run.status = "SUCCESS";
    run.finishedAt = new Date().toISOString();
    run.sourceFeedHash = signature;
    run.sessionsScheduled = output.stats.scheduled + output.stats.locked;
    run.sessionsNeedsAttention = output.stats.needsAttention;
    run.sessionsCancelled = output.stats.cancelled;
    repo.updateRun(run);

    logger.info(
      { runId, ...output.stats },
      "Regeneration complete"
    );
    return run;
  } catch (err) {
    const message =
      err instanceof FeedFetchError || err instanceof AssessmentLoadError
        ? err.message
        : `Unexpected error: ${(err as Error).message}`;
    logger.error({ runId, err: message }, "Regeneration failed; continuing to serve last known-good output");
    run.status = "FAILED";
    run.finishedAt = new Date().toISOString();
    run.error = message;
    repo.updateRun(run);
    return run;
  }
}
