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
  /** Date (Europe/Paris civil date) the assessment occurs on. */
  date: ISODate;
  /** Optional local start time "HH:mm"; if absent the whole day is protected. */
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
}

export interface Config {
  timezone: string;
  sourceFeed: {
    url: string;
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
    maxDailyMinutes: number;
    classLoadAdjustment: {
      enabled: boolean;
      minutesReducedPerClassHour: number;
      floorMinutes: number;
    };
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
  blockedPeriods: { startUtc: ISODateTime; endUtc: ISODateTime; reason: string }[];
  examProtection: {
    scope: "all-subjects";
    blackoutDays: number;
    pullForwardMaxDays: number;
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
