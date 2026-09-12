import type {
  Config,
  Override,
  OverrideAction,
  SchedulingInput,
  SchedulingOutput,
  SourceEvent,
  StudySession,
} from "../types.js";
import { computeExamBlackouts } from "../assessments/blackout.js";
import { computeClassMinutesByDate, effectiveMaxMinutes, effectivePreferredMinutes } from "./workload.js";
import { generateCandidatesForDate, toInterval, tooClose, overlaps, type Interval } from "./candidates.js";
import { addDaysToDateString, localDateString, minutesOfDay } from "../util/timezone.js";
import { dayDiff } from "./dateMath.js";

interface OccupiedEntry {
  interval: Interval;
  kind: "class" | "study" | "blocked" | "blackout";
}

interface Blackout {
  startUtc: string;
  endUtc: string;
}

interface EffectiveOverride {
  action: OverrideAction | null; // null = no active override (never set, or last action was UNLOCK)
  newStartUtc: string | null;
  newEndUtc: string | null;
}

function resolveEffectiveOverrides(overrides: Override[]): Map<string, EffectiveOverride> {
  const latestBySession = new Map<string, Override>();
  for (const o of overrides) {
    const existing = latestBySession.get(o.studySessionId);
    if (!existing || new Date(o.createdAt).getTime() >= new Date(existing.createdAt).getTime()) {
      latestBySession.set(o.studySessionId, o);
    }
  }
  const out = new Map<string, EffectiveOverride>();
  for (const [sessionId, o] of latestBySession) {
    if (o.action === "UNLOCK") {
      out.set(sessionId, { action: null, newStartUtc: null, newEndUtc: null });
    } else {
      out.set(sessionId, {
        action: o.action,
        newStartUtc: o.newStartUtc,
        newEndUtc: o.newEndUtc,
      });
    }
  }
  return out;
}

function sessionId(canonicalId: string, reviewName: string): string {
  return `study-${canonicalId}-${reviewName}`;
}

/**
 * The pure scheduling boundary described in the design doc:
 *   (SourceEvents, Assessments, Config, Overrides, PrevState) -> NewState
 *
 * No I/O, no clock reads (nowUtc is injected), no randomness. Given the
 * same inputs this always produces the same output.
 */
export function runScheduling(input: SchedulingInput): SchedulingOutput {
  const { sourceEvents, assessments, config, overrides, blockedPeriods, prevSessions, nowUtc } = input;
  const blackouts = computeExamBlackouts(assessments, config);

  const effectiveOverrides = resolveEffectiveOverrides(overrides);
  const prevById = new Map(prevSessions.map((s) => [s.id, s]));
  const currentCanonicalIds = new Set(sourceEvents.map((e) => e.canonicalId));
  const sourceEventById = new Map(sourceEvents.map((e) => [e.canonicalId, e]));

  const classMinutesByDate = computeClassMinutesByDate(sourceEvents, config.timezone, config);

  const results: StudySession[] = [];
  const occupied: OccupiedEntry[] = [];

  for (const ev of sourceEvents) {
    occupied.push({
      interval: toInterval(ev.startUtc, ev.endUtc),
      kind: "class",
    });
  }
  for (const bp of blockedPeriods) {
    occupied.push({ interval: toInterval(bp.startUtc, bp.endUtc), kind: "blocked" });
  }
  for (const b of blackouts) {
    occupied.push({ interval: toInterval(b.startUtc, b.endUtc), kind: "blackout" });
  }

  // --- Step 1: sessions whose source event has disappeared entirely ---
  const stillRelevantIds = new Set<string>();
  for (const ev of sourceEvents) {
    for (const r of config.reviews) {
      stillRelevantIds.add(sessionId(ev.canonicalId, r.name));
    }
  }
  for (const prev of prevSessions) {
    if (stillRelevantIds.has(prev.id)) continue; // still relevant, handled below
    if (currentCanonicalIds.has(prev.sourceCanonicalId)) continue; // shouldn't happen, guard
    const eff = effectiveOverrides.get(prev.id);
    const isLocked = eff?.action === "LOCK" || eff?.action === "RESCHEDULE";
    if (isLocked && prev.startUtc && prev.endUtc) {
      const locked: StudySession = {
        ...prev,
        status: "LOCKED",
        orphaned: true,
        hasManualOverride: true,
        needsAttentionReason: null,
        updatedAt: nowUtc,
      };
      results.push(locked);
      occupied.push({ interval: toInterval(locked.startUtc!, locked.endUtc!), kind: "study" });
    } else {
      results.push({
        ...prev,
        status: "CANCELLED",
        orphaned: false,
        startUtc: null,
        endUtc: null,
        hasManualOverride: Boolean(eff?.action),
        needsAttentionReason: null,
        updatedAt: nowUtc,
      });
    }
  }

  // --- Step 2: build the list of (sourceEvent, reviewSpec) pairs to resolve ---
  type Pending = { ev: SourceEvent; reviewIndex: number; id: string };
  const pending: Pending[] = [];
  for (const ev of sourceEvents) {
    config.reviews.forEach((r, idx) => {
      pending.push({ ev, reviewIndex: idx, id: sessionId(ev.canonicalId, r.name) });
    });
  }

  // --- Step 3: resolve overridden sessions first (SKIP / LOCK / RESCHEDULE with explicit position) ---
  const autoQueue: Pending[] = [];
  for (const p of pending) {
    const eff = effectiveOverrides.get(p.id);
    const prev = prevById.get(p.id);
    const reviewSpec = config.reviews[p.reviewIndex]!;

    if (eff?.action === "SKIP") {
      results.push(makeSession(p, reviewSpec, prev, nowUtc, {
        status: "SKIPPED",
        startUtc: null,
        endUtc: null,
        orphaned: false,
        hasManualOverride: true,
        needsAttentionReason: null,
      }));
      continue;
    }

    if (eff?.action === "RESCHEDULE" && eff.newStartUtc && eff.newEndUtc) {
      results.push(makeSession(p, reviewSpec, prev, nowUtc, {
        status: "LOCKED",
        startUtc: eff.newStartUtc,
        endUtc: eff.newEndUtc,
        orphaned: false,
        hasManualOverride: true,
        needsAttentionReason: null,
      }));
      occupied.push({ interval: toInterval(eff.newStartUtc, eff.newEndUtc), kind: "study" });
      continue;
    }

    if (eff?.action === "LOCK" && prev?.startUtc && prev?.endUtc) {
      results.push(makeSession(p, reviewSpec, prev, nowUtc, {
        status: "LOCKED",
        startUtc: prev.startUtc,
        endUtc: prev.endUtc,
        orphaned: false,
        hasManualOverride: true,
        needsAttentionReason: null,
      }));
      occupied.push({ interval: toInterval(prev.startUtc, prev.endUtc), kind: "study" });
      continue;
    }

    // LOCK with no prior placement, or no override at all: goes through auto-scheduling.
    // (A same-run LOCK-without-prior-placement is treated as "auto-place, then pin" —
    // see note below where we apply the pending lock flag after placement.)
    autoQueue.push(p);
  }

  // --- Step 4: deterministic processing order for auto-scheduled sessions ---
  autoQueue.sort((a, b) => {
    const dateA = localDateString(new Date(a.ev.startUtc), config.timezone);
    const dateB = localDateString(new Date(b.ev.startUtc), config.timezone);
    if (dateA !== dateB) return dateA < dateB ? -1 : 1;
    if (a.reviewIndex !== b.reviewIndex) return a.reviewIndex - b.reviewIndex;
    return a.ev.canonicalId < b.ev.canonicalId ? -1 : a.ev.canonicalId > b.ev.canonicalId ? 1 : 0;
  });

  const studyMinutesByDate = new Map<string, number>();

    for (const p of autoQueue) {
        const reviewSpec = config.reviews[p.reviewIndex]!;
        const prev = prevById.get(p.id);
        const eff = effectiveOverrides.get(p.id);
        const ownClassDate = localDateString(new Date(p.ev.startUtc), config.timezone);

        let searchDates: string[];
        let targetDateForRanking: string | null = null;
        let earliestDateForPullForward: string | null = null;

        if (reviewSpec.anySlot) {
            // First-fit mode: ignore targetOffsetDays/flexibilityDays entirely
            // and take the first available slot anywhere from the day after
            // class through the end of the configured horizon.
            const today = localDateString(new Date(nowUtc), config.timezone);
            const horizonEndDate = addDaysToDateString(today, config.horizon.lookaheadDays);
            const searchStart = addDaysToDateString(ownClassDate, 1);
            const searchEnd = horizonEndDate > searchStart ? horizonEndDate : searchStart;
            searchDates = enumerateDates(searchStart, searchEnd).filter((d) => d !== ownClassDate);
        } else {
            const targetDate = addDaysToDateString(ownClassDate, reviewSpec.targetOffsetDays);
            const earliestDate = addDaysToDateString(targetDate, -reviewSpec.flexibilityDays);
            const latestDate = addDaysToDateString(targetDate, reviewSpec.flexibilityDays);
            searchDates = enumerateDates(earliestDate, latestDate).filter((d) => d !== ownClassDate);
            targetDateForRanking = targetDate;
            earliestDateForPullForward = earliestDate;
        }

        // Stability preference: keep the previous auto-placement if it's still valid.
        if (
            !eff &&
            prev &&
            prev.status === "SCHEDULED" &&
            prev.startUtc &&
            prev.endUtc &&
            searchDates.includes(localDateString(new Date(prev.startUtc), config.timezone)) &&
            isValidPlacement(prev.startUtc, prev.endUtc, occupied, config, classMinutesByDate, studyMinutesByDate, config.grid.sessionMinutes, config.timezone)
        ) {
            const session = makeSession(p, reviewSpec, prev, nowUtc, {
                status: "SCHEDULED",
                startUtc: prev.startUtc,
                endUtc: prev.endUtc,
                orphaned: false,
                hasManualOverride: false,
                needsAttentionReason: null,
            });
            results.push(session);
            commitPlacement(prev.startUtc, prev.endUtc, occupied, studyMinutesByDate, config.timezone);
            continue;
        }

        let best: { startUtc: Date; endUtc: Date } | null;
        if (reviewSpec.anySlot) {
            best = pickFirstFitCandidate(searchDates, config, occupied, classMinutesByDate, studyMinutesByDate);
        } else {
            best = pickBestCandidate(
                searchDates, p.ev, config, occupied, classMinutesByDate, studyMinutesByDate, targetDateForRanking!, blackouts
            );
        }

        let usedPullForward = false;
        if (!best && !reviewSpec.anySlot && reviewSpec.name === "far" && config.examProtection.pullForwardMaxDays > 0 && earliestDateForPullForward) {
            const minPullDate = addDaysToDateString(ownClassDate, 1);
            let pullEarliest = addDaysToDateString(earliestDateForPullForward, -config.examProtection.pullForwardMaxDays);
            if (pullEarliest < minPullDate) pullEarliest = minPullDate;
            const pullLatest = addDaysToDateString(earliestDateForPullForward, -1);
            const pullDates =
                pullEarliest <= pullLatest
                    ? enumerateDates(pullEarliest, pullLatest).filter((d) => d !== ownClassDate)
                    : [];
            best = pickBestCandidate(
                pullDates, p.ev, config, occupied, classMinutesByDate, studyMinutesByDate, targetDateForRanking!, blackouts
            );
            usedPullForward = Boolean(best);
        }

        if (!best) {
            results.push(makeSession(p, reviewSpec, prev, nowUtc, {
                status: "NEEDS_ATTENTION",
                startUtc: null,
                endUtc: null,
                orphaned: false,
                hasManualOverride: false,
                needsAttentionReason: reviewSpec.anySlot
                    ? "No free slot found anywhere in the remaining horizon"
                    : `No valid ${config.grid.sessionMinutes}-minute slot found within the allowed window` +
                    (reviewSpec.name === "far" ? " (pull-forward exhausted)" : ""),
            }));
            continue;
        }

        const startIso = best.startUtc.toISOString();
        const endIso = best.endUtc.toISOString();
        const finalStatus = eff?.action === "LOCK" ? "LOCKED" : "SCHEDULED";

        results.push(makeSession(p, reviewSpec, prev, nowUtc, {
            status: finalStatus,
            startUtc: startIso,
            endUtc: endIso,
            orphaned: false,
            hasManualOverride: finalStatus === "LOCKED",
            needsAttentionReason: null,
        }));
        commitPlacement(startIso, endIso, occupied, studyMinutesByDate, config.timezone);
        void usedPullForward;
    }

  const stats = {
    scheduled: results.filter((r) => r.status === "SCHEDULED").length,
    needsAttention: results.filter((r) => r.status === "NEEDS_ATTENTION").length,
    cancelled: results.filter((r) => r.status === "CANCELLED").length,
    skipped: results.filter((r) => r.status === "SKIPPED").length,
    locked: results.filter((r) => r.status === "LOCKED").length,
  };

  return { sessions: results, stats };
}

function enumerateDates(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = start;
  let guard = 0;
  while (cur <= end && guard++ < 10_000) {
    out.push(cur);
    cur = addDaysToDateString(cur, 1);
  }
  return out;
}

function makeSession(
  p: { ev: SourceEvent; reviewIndex: number; id: string },
  reviewSpec: { name: string },
  prev: StudySession | undefined,
  nowUtc: string,
  fields: Pick<
    StudySession,
    "status" | "startUtc" | "endUtc" | "orphaned" | "hasManualOverride" | "needsAttentionReason"
  >
): StudySession {
  return {
    id: p.id,
    sourceCanonicalId: p.ev.canonicalId,
    sourceSummary: p.ev.summary,
    reviewName: reviewSpec.name,
    createdAt: prev?.createdAt ?? nowUtc,
    updatedAt: nowUtc,
    ...fields,
  };
}

function isValidPlacement(
  startIso: string,
  endIso: string,
  occupied: OccupiedEntry[],
  config: Config,
  classMinutesByDate: Map<string, number>,
  studyMinutesByDate: Map<string, number>,
  sessionMinutes: number,
  timezone: string
): boolean {
  const interval = toInterval(startIso, endIso);
  for (const entry of occupied) {
    if (entry.kind === "class" || entry.kind === "study") {
      if (tooClose(interval, entry.interval, config.grid.minBufferMinutes)) return false;
    } else {
      if (overlaps(interval, entry.interval)) return false;
    }
  }
  const date = localDateString(new Date(startIso), timezone);
  const existingStudy = studyMinutesByDate.get(date) ?? 0;
  const classMinutes = classMinutesByDate.get(date) ?? 0;
  const max = effectiveMaxMinutes(classMinutes, config);
  return existingStudy + sessionMinutes <= max;
}

function commitPlacement(
  startIso: string,
  endIso: string,
  occupied: OccupiedEntry[],
  studyMinutesByDate: Map<string, number>,
  timezone: string
) {
  occupied.push({ interval: toInterval(startIso, endIso), kind: "study" });
  const date = localDateString(new Date(startIso), timezone);
  const minutes = (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000;
  studyMinutesByDate.set(date, (studyMinutesByDate.get(date) ?? 0) + minutes);
}

/**
 * Extra "effective distance" penalty for a candidate date that's close to
 * (or after) the start of an upcoming exam blackout. This pushes sessions to
 * be placed earlier, proactively, instead of only being forced there once
 * everything closer to the target is already full.
 */
function blackoutApproachPenalty(date: string, blackouts: Blackout[], config: Config): number {
  const { approachPenaltyDays, approachPenaltyWeight } = config.examProtection;
  if (approachPenaltyDays <= 0 || approachPenaltyWeight <= 0) return 0;
  let penalty = 0;
  for (const b of blackouts) {
    const blackoutStartDate = b.startUtc.slice(0, 10); // "YYYY-MM-DD" prefix of an ISO instant
    const daysUntil = dayDiff(date, blackoutStartDate);
    if (daysUntil >= 0 && daysUntil <= approachPenaltyDays) {
      const thisPenalty = (approachPenaltyDays - daysUntil) * approachPenaltyWeight;
      penalty = Math.max(penalty, thisPenalty);
    }
  }
  return penalty;
}

interface RankedCandidate {
  startUtc: Date;
  endUtc: Date;
  date: string;
  effectiveDistance: number;
  workloadOverage: number;
  minutesOfDayStart: number;
}

/**
 * Strict chronological first-fit: earliest date, then earliest start time,
 * with no distance/compaction/workload-preferred ranking at all -- only
 * hard constraints (buffer/overlap against classes/study/blocked/blackout,
 * and the day's hard maxDailyMinutes cap).
 */
function pickFirstFitCandidate(
    dates: string[],
    config: Config,
    occupied: OccupiedEntry[],
    classMinutesByDate: Map<string, number>,
    studyMinutesByDate: Map<string, number>
): { startUtc: Date; endUtc: Date } | null {
    for (const date of dates) {
        const classMinutes = classMinutesByDate.get(date) ?? 0;
        const max = effectiveMaxMinutes(classMinutes, config);
        const existingStudy = studyMinutesByDate.get(date) ?? 0;
        if (existingStudy + config.grid.sessionMinutes > max) continue;

        const candidates = generateCandidatesForDate(date, config);
        for (const c of candidates) {
            const interval = toInterval(c.startUtc, c.endUtc);
            let ok = true;
            for (const entry of occupied) {
                if (entry.kind === "class" || entry.kind === "study") {
                    if (tooClose(interval, entry.interval, config.grid.minBufferMinutes)) { ok = false; break; }
                } else {
                    if (overlaps(interval, entry.interval)) { ok = false; break; }
                }
            }
            if (ok) return { startUtc: c.startUtc, endUtc: c.endUtc };
        }
    }
    return null;
}

function pickBestCandidate(
  dates: string[],
  ev: SourceEvent,
  config: Config,
  occupied: OccupiedEntry[],
  classMinutesByDate: Map<string, number>,
  studyMinutesByDate: Map<string, number>,
  targetDate: string,
  blackouts: Blackout[]
): { startUtc: Date; endUtc: Date } | null {
  const ranked: RankedCandidate[] = [];

  for (const date of dates) {
    const classMinutes = classMinutesByDate.get(date) ?? 0;
    const preferred = effectivePreferredMinutes(classMinutes, config);
    const max = effectiveMaxMinutes(classMinutes, config);
    const existingStudy = studyMinutesByDate.get(date) ?? 0;
    const resultingMinutes = existingStudy + config.grid.sessionMinutes;
    if (resultingMinutes > max) continue; // hard cap, this whole date is full

    const candidates = generateCandidatesForDate(date, config);
    for (const c of candidates) {
      const interval = toInterval(c.startUtc, c.endUtc);
      let ok = true;
      for (const entry of occupied) {
        if (entry.kind === "class" || entry.kind === "study") {
          if (tooClose(interval, entry.interval, config.grid.minBufferMinutes)) {
            ok = false;
            break;
          }
        } else {
          if (overlaps(interval, entry.interval)) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;

      const rawDistance = Math.abs(dayDiff(targetDate, date));
      // Reward days that already have a study session on them (up to the
      // day's cap) so sessions cluster together during busy weeks instead
      // of each independently minimizing its own distance-to-target and
      // spreading across the whole flexibility window.
      const compactionDiscount = existingStudy > 0 ? config.workload.compactionBonusDays : 0;
      const approachPenalty = blackoutApproachPenalty(date, blackouts, config);
      const effectiveDistance = Math.max(0, rawDistance - compactionDiscount) + approachPenalty;

      ranked.push({
        startUtc: c.startUtc,
        endUtc: c.endUtc,
        date,
        effectiveDistance,
        workloadOverage: Math.max(0, resultingMinutes - preferred),
        minutesOfDayStart: minutesOfDay(c.startUtc, config.timezone),
      });
    }
  }

  if (ranked.length === 0) return null;

  ranked.sort((a, b) => {
    if (a.effectiveDistance !== b.effectiveDistance) return a.effectiveDistance - b.effectiveDistance;
    if (a.workloadOverage !== b.workloadOverage) return a.workloadOverage - b.workloadOverage;
    if (a.minutesOfDayStart !== b.minutesOfDayStart) return a.minutesOfDayStart - b.minutesOfDayStart;
    // final deterministic tie-break: date asc, start time asc (already asc above), canonical id asc (constant here)
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.startUtc.getTime() - b.startUtc.getTime();
  });

  const winner = ranked[0]!;
  return { startUtc: winner.startUtc, endUtc: winner.endUtc };
}
