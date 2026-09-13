/**
 * Core domain types. These are the shapes that flow through the pure
 * scheduling boundary:
 *
 *   (SourceEvents, Assessments, Config, Overrides, PrevState) -> NewState
 *
 * Nothing in here should import from http/ics-output/cron/state.
 */

export type ISODate = string; // "YYYY-MM-DD"
export type ISODateTime = string; // ISO 8601, always stored as UTC instant

/** A normalized, stable representation of a university timetable event. */
export interface SourceEvent {
  /** Stable identity across regenerations. See normalization/canonicalId.ts */
  canonicalId: string;
  /** Raw UID from the ICS feed at the time of last observation (may churn). */
  rawUid: string;
  /** Recurrence-id / instance key if this occurrence came from an RRULE expansion. */
  recurrenceKey: string | null;
  summary: string;
  startUtc: ISODateTime;
  endUtc: ISODateTime;
  /** IANA timezone the event was authored in, if known (feed may be floating). */
  sourceTimezone: string | null;
  /** True if the source ICS VEVENT had no timezone information (floating time). */
  wasFloating: boolean;
  location: string | null;
  /** First-seen timestamp, preserved across regenerations for the same canonicalId. */
  firstSeenAt: ISODateTime;
  /** Last regeneration run in which this event was observed in the feed. */
  lastSeenRunId: string | null;
}

export type AssessmentType = string;

export interface Assessment {
    id: string;
    subject: string;
    type: AssessmentType;
    date: ISODate;
    /** Last day of a multi-day assessment. Equals `date` for single-day exams. */
    endDate: ISODate;
    startTime: string | null;
    endTime: string | null;
    title: string;
}

export type ReviewName = string; // e.g. "near" | "far", driven by config

export type StudySessionStatus =
  | "SCHEDULED"
  | "LOCKED"
  | "SKIPPED"
  | "CANCELLED"
  | "NEEDS_ATTENTION";

export interface StudySession {
  /** Stable internal id: study-{sourceEvent.canonicalId}-{reviewName} */
  id: string;
  sourceCanonicalId: string;
  sourceSummary: string;
  reviewName: ReviewName;
  status: StudySessionStatus;
  /** Present whenever the session has a concrete placement (incl. locked/orphaned). */
  startUtc: ISODateTime | null;
  endUtc: ISODateTime | null;
  /** True only when status === "LOCKED" and the source class vanished from the feed. */
  orphaned: boolean;
  /** True if a human LOCK/SKIP/RESCHEDULE override is currently applied. */
  hasManualOverride: boolean;
  /** Free-text reason set when status is NEEDS_ATTENTION. */
  needsAttentionReason: string | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type OverrideAction = "LOCK" | "SKIP" | "RESCHEDULE" | "UNLOCK";

export interface Override {
  id: string;
  studySessionId: string;
  action: OverrideAction;
  /** Required for RESCHEDULE. */
  newStartUtc: ISODateTime | null;
  newEndUtc: ISODateTime | null;
  createdAt: ISODateTime;
}

export interface BlockedPeriod {
  id: string;
  startUtc: ISODateTime;
  endUtc: ISODateTime;
  reason: string;
}

export interface TimeWindow {
  start: string; // "HH:mm"
  end: string; // "HH:mm"
}

export interface ReviewSpec {
    name: ReviewName;
    targetOffsetDays: number;
    flexibilityDays: number;
    /**
     * If true, ignore targetOffsetDays/flexibilityDays entirely and take the
     * first available slot anywhere from the day after class through the end
     * of the configured horizon (chronological first-fit).
     */
    anySlot?: boolean;
}

export type Weekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export interface RecurringBlockedPeriod {
  weekday: Weekday;
  start: string; // "HH:mm" local
  end: string; // "HH:mm" local
    reason: string;
    visible?: boolean;
    /**
     * Extra minutes of margin padded onto each side of this block purely
     * for scheduling purposes -- e.g. so a study session can't be placed
     * immediately before/after basketball with zero gap. Never affects the
     * visible calendar event itself, which always shows the real,
     * un-padded start/end time. 0/omitted = no padding (previous behavior).
     */
    bufferMinutes?: number;
}

export interface ClassWeightRule {
  /** Regex (case-insensitive) matched against "{summary} {location}". */
  pattern: string;
  weight: number;
}

export interface Config {
  timezone: string;
  sourceFeed: {
    /** Fetch the university timetable over HTTP(S). Mutually exclusive with `file`. */
    url?: string;
    /**
     * Read the university timetable from a local .ics file on disk instead of
     * fetching a URL. Path is resolved relative to the process cwd. Mutually
     * exclusive with `url`. Useful when the university feed is unreliable or
     * time-limited (e.g. only exposes a rolling window) -- export the whole
     * semester once and point this at the exported file.
     */
    file?: string;
    fetchTimeoutSeconds: number;
    maxResponseBytes: number;
  };
  studyWindows: {
    weekdays: TimeWindow[];
    weekends: TimeWindow[];
  };
  grid: {
    blockMinutes: number;
    sessionMinutes: number;
    minBufferMinutes: number;
  };
  reviews: ReviewSpec[];
  workload: {
    preferredDailyMinutes: number;
    maxDailyMinutes: number | null;
    classLoadAdjustment: {
      enabled: boolean;
      minutesReducedPerClassHour: number;
      floorMinutes: number;
    };
    /**
     * A candidate day that already has at least one study session placed on
     * it is treated as this many days closer to the review's target date
     * than an otherwise-empty day, encouraging sessions to cluster on
     * already-used days instead of spreading across the whole flexibility
     * window. 0 disables clustering preference.
     */
    compactionBonusDays: number;
  };
  /**
   * Weights class time by type (e.g. TD/TP vs CM) before it's fed into
   * classLoadAdjustment, so lighter/more-numerous class types don't crush a
   * day's study capacity the way a full lecture would. Rules are tried in
   * order; the first matching pattern wins. Unmatched events use
   * `defaultWeight`.
   */
  classWeighting: {
    defaultWeight: number;
    rules: ClassWeightRule[];
  };
  assessments: {
    file: string;
    protectedTypes: AssessmentType[];
  };
  /**
   * Statically configured blocked periods (e.g. travel, family commitments).
   * Not enumerated in the design doc's sample YAML, but "respect configured
   * blocked periods" is a required rule with no other configuration surface
   * given, so they live here. See README's "unspecified assumptions".
   */
  blockedPeriods: { startUtc: ISODateTime; endUtc: ISODateTime; reason: string; visible?: boolean }[];
  /**
   * Weekly recurring blocked windows (e.g. sports practice, standing
   * commitments). Expanded into concrete blockedPeriods for the active
   * horizon before each scheduling run.
   */
  recurringBlockedPeriods: RecurringBlockedPeriod[];
  examProtection: {
    scope: "all-subjects";
    blackoutDays: number;
    pullForwardMaxDays: number;
    /**
     * Once a candidate date is within this many days of an upcoming exam
     * blackout, a ranking penalty is applied (see approachPenaltyWeight) so
     * sessions are pushed earlier instead of piling up right at the edge
     * of the blackout. 0 disables the penalty.
     */
    approachPenaltyDays: number;
    /** "Effective distance days" added per day of closeness once inside approachPenaltyDays. */
    approachPenaltyWeight: number;
  };
  horizon: {
    lookaheadDays: number;
    lookbackDays: number;
  };
  regeneration: {
    cronTime: string; // "HH:mm"
    cronTimezone: string;
  };
}

export type RunStatus = "SUCCESS" | "NO_OP" | "FAILED" | "RUNNING";
export type RunTrigger = "startup" | "cron" | "manual";

export interface SchedulingRun {
  id: string;
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: ISODateTime;
  finishedAt: ISODateTime | null;
  sourceFeedHash: string | null;
  sessionsScheduled: number;
  sessionsNeedsAttention: number;
  sessionsCancelled: number;
  error: string | null;
}

/** Everything the pure scheduling engine needs as input. */
export interface SchedulingInput {
  sourceEvents: SourceEvent[];
  assessments: Assessment[];
  config: Config;
  overrides: Override[];
  blockedPeriods: BlockedPeriod[];
  prevSessions: StudySession[];
  /** Reference "now" instant, injected for determinism in tests. */
  nowUtc: ISODateTime;
  runId: string;
}

export interface SchedulingOutput {
  sessions: StudySession[];
  stats: {
    scheduled: number;
    needsAttention: number;
    cancelled: number;
    skipped: number;
    locked: number;
  };
}
