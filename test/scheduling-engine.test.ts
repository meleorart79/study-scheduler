import { describe, it, expect } from "vitest";
import { runScheduling } from "../src/scheduling/engine.js";
import { minutesOfDay, localDateString } from "../src/util/timezone.js";
import { baseConfig, makeSourceEvent, makeAssessment, makeOverride, findSession } from "./helpers.js";
import type { SchedulingInput, StudySession } from "../src/types.js";

function baseInput(overrides: Partial<SchedulingInput> = {}): SchedulingInput {
  return {
    sourceEvents: [],
    assessments: [],
    config: baseConfig(),
    overrides: [],
    blockedPeriods: [],
    prevSessions: [],
    nowUtc: "2026-09-01T00:00:00.000Z",
    runId: "run-1",
    ...overrides,
  };
}

describe("scheduling engine: basic placement", () => {
  it("schedules near (+1d) and far (+7d) reviews for a single class", () => {
    // Tuesday 2026-09-08 09:00-11:00 Europe/Paris
    const ev = makeSourceEvent();
    const { sessions, stats } = runScheduling(baseInput({ sourceEvents: [ev] }));

    expect(stats.scheduled).toBe(2);
    const near = findSession(sessions, ev.canonicalId, "near");
    const far = findSession(sessions, ev.canonicalId, "far");
    expect(near.status).toBe("SCHEDULED");
    expect(far.status).toBe("SCHEDULED");
    expect(near.startUtc).not.toBeNull();
    expect(far.startUtc).not.toBeNull();

    // near should land close to +1 day (2026-09-09), far close to +7 (2026-09-15)
    const nearDate = localDateString(new Date(near.startUtc!), "Europe/Paris");
    const farDate = localDateString(new Date(far.startUtc!), "Europe/Paris");
    expect(["2026-09-09", "2026-09-10"]).toContain(nearDate); // target or +1 (own-day excluded is 09-08)
    expect(farDate >= "2026-09-12" && farDate <= "2026-09-18").toBe(true);
  });

  it("never schedules a study session on the same calendar day as its source class", () => {
    const ev = makeSourceEvent(); // Tue 2026-09-08
    const { sessions } = runScheduling(baseInput({ sourceEvents: [ev] }));
    for (const s of sessions) {
      if (!s.startUtc) continue;
      const date = localDateString(new Date(s.startUtc), "Europe/Paris");
      expect(date).not.toBe("2026-09-08");
    }
  });

  it("session length is exactly 90 minutes and grid-aligned to 15 minutes", () => {
    const ev = makeSourceEvent();
    const { sessions } = runScheduling(baseInput({ sourceEvents: [ev] }));
    for (const s of sessions) {
      if (!s.startUtc || !s.endUtc) continue;
      const durationMin = (new Date(s.endUtc).getTime() - new Date(s.startUtc).getTime()) / 60000;
      expect(durationMin).toBe(90);
      const startMin = minutesOfDay(new Date(s.startUtc), "Europe/Paris");
      expect(startMin % 15).toBe(0);
    }
  });
});

describe("scheduling engine: classes as implicit blocks + buffer", () => {
  it("keeps at least 15 minutes buffer between a study session and a class", () => {
    const ev = makeSourceEvent(); // Tue class
    // A second class on the "near" target day (Wed 2026-09-09) that occupies
    // almost the entire weekday study window, leaving only a narrow gap.
    const blocker = makeSourceEvent({
      canonicalId: "blocker-1",
      summary: "Databases Lecture",
      startUtc: "2026-09-09T09:45:00.000Z", // 11:45 Paris
      endUtc: "2026-09-09T17:45:00.000Z", // 19:45 Paris
    });
    const { sessions } = runScheduling(baseInput({ sourceEvents: [ev, blocker] }));
    const near = findSession(sessions, ev.canonicalId, "near");
    if (near.startUtc) {
      const startMs = new Date(near.startUtc).getTime();
      const endMs = new Date(near.endUtc!).getTime();
      const blockerStart = new Date(blocker.startUtc).getTime();
      const blockerEnd = new Date(blocker.endUtc).getTime();
      const gapBefore = blockerStart - endMs;
      const gapAfter = startMs - blockerEnd;
      // If it lands adjacent to the blocker on the same day, must respect buffer.
      const sameDay = localDateString(new Date(near.startUtc), "Europe/Paris") === "2026-09-09";
      if (sameDay) {
        const touchesBefore = endMs <= blockerStart;
        const touchesAfter = startMs >= blockerEnd;
        if (touchesBefore) expect(gapBefore).toBeGreaterThanOrEqual(15 * 60_000);
        if (touchesAfter) expect(gapAfter).toBeGreaterThanOrEqual(15 * 60_000);
      }
    }
  });

  it("never overlaps another study session and keeps buffer between study sessions", () => {
    // Two classes on the same day so their "near" reviews compete for the same window.
    const ev1 = makeSourceEvent({ canonicalId: "c1", summary: "Class A", startUtc: "2026-09-08T07:00:00.000Z", endUtc: "2026-09-08T09:00:00.000Z" });
    const ev2 = makeSourceEvent({ canonicalId: "c2", summary: "Class B", startUtc: "2026-09-08T09:15:00.000Z", endUtc: "2026-09-08T11:15:00.000Z" });
    const { sessions } = runScheduling(baseInput({ sourceEvents: [ev1, ev2] }));
    const placed = sessions.filter((s) => s.startUtc && s.endUtc);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]!;
        const b = placed[j]!;
        const aStart = new Date(a.startUtc!).getTime();
        const aEnd = new Date(a.endUtc!).getTime();
        const bStart = new Date(b.startUtc!).getTime();
        const bEnd = new Date(b.endUtc!).getTime();
        const gap = aStart < bStart ? bStart - aEnd : aStart - bEnd;
        expect(gap).toBeGreaterThanOrEqual(15 * 60_000);
      }
    }
  });
});

describe("scheduling engine: workload", () => {
  it("respects effectiveMax daily minutes as a hard cap", () => {
    const config = baseConfig((c) => {
      c.workload.maxDailyMinutes = 90; // only one 90-min session allowed per day at most
      c.workload.classLoadAdjustment.enabled = false;
      c.reviews = [
        { name: "near", targetOffsetDays: 1, flexibilityDays: 0 },
      ];
    });
    // Two different classes both targeting the exact same single candidate day.
    const ev1 = makeSourceEvent({ canonicalId: "c1", startUtc: "2026-09-08T07:00:00.000Z", endUtc: "2026-09-08T09:00:00.000Z" });
    const ev2 = makeSourceEvent({ canonicalId: "c2", startUtc: "2026-09-08T09:15:00.000Z", endUtc: "2026-09-08T11:15:00.000Z" });
    const { sessions } = runScheduling(baseInput({ sourceEvents: [ev1, ev2], config }));
    const s1 = findSession(sessions, "c1", "near");
    const s2 = findSession(sessions, "c2", "near");
    // With flexibilityDays: 0, both only have 2026-09-09 as their only candidate date.
    // maxDailyMinutes=90 means only one of them can fit; the other must be NEEDS_ATTENTION.
    const statuses = [s1.status, s2.status].sort();
    expect(statuses).toEqual(["NEEDS_ATTENTION", "SCHEDULED"]);
  });
});

describe("scheduling engine: NEEDS_ATTENTION", () => {
  it("marks a session NEEDS_ATTENTION and omits placement when no valid slot exists", () => {
    const config = baseConfig((c) => {
      c.reviews = [{ name: "near", targetOffsetDays: 1, flexibilityDays: 0 }];
    });
    const ev = makeSourceEvent();
    // Block the entirety of the only candidate day (2026-09-09) via a configured blocked period.
    const { sessions } = runScheduling(
      baseInput({
        sourceEvents: [ev],
        config,
        blockedPeriods: [
          {
            id: "b1",
            startUtc: "2026-09-08T22:00:00.000Z", // covers all of 2026-09-09 Europe/Paris
            endUtc: "2026-09-09T22:00:00.000Z",
            reason: "test block",
          },
        ],
      })
    );
    const near = findSession(sessions, ev.canonicalId, "near");
    expect(near.status).toBe("NEEDS_ATTENTION");
    expect(near.startUtc).toBeNull();
    expect(near.needsAttentionReason).not.toBeNull();
  });
});

describe("scheduling engine: exam protection + pull-forward", () => {
  it("blocks all subjects' sessions during the blackout window (all-subjects scope)", () => {
    const config = baseConfig((c) => {
      c.reviews = [{ name: "near", targetOffsetDays: 1, flexibilityDays: 0 }];
      c.examProtection.blackoutDays = 7;
    });
    const ev = makeSourceEvent({ summary: "Unrelated Subject" });
    const assessment = makeAssessment({ date: "2026-09-16", type: "partiel" }); // blackout covers back to 09-09
    const { sessions } = runScheduling(
      baseInput({ sourceEvents: [ev], config, assessments: [assessment] })
    );
    const near = findSession(sessions, ev.canonicalId, "near");
    expect(near.status).toBe("NEEDS_ATTENTION");
  });

  it("pulls a far review forward to escape an exam blackout, when near review of the same window would not", () => {
    const config = baseConfig((c) => {
      c.examProtection.blackoutDays = 7;
      c.examProtection.pullForwardMaxDays = 6;
    });
    // Far review target = +7d = 2026-09-15, flex ±3 => 09-12..09-18. A whole-day
    // (no explicit time) blackout for an exam on 09-19, with blackoutDays=7,
    // covers 09-12 00:00 through 09-20 00:00 -- i.e. all of the normal window.
    const ev = makeSourceEvent(); // Tue 2026-09-08
    const assessment = makeAssessment({ date: "2026-09-19", type: "partiel", startTime: null, endTime: null });
    const { sessions } = runScheduling(
      baseInput({ sourceEvents: [ev], config, assessments: [assessment] })
    );
    const far = findSession(sessions, ev.canonicalId, "far");
    expect(far.status).toBe("SCHEDULED");
    const farDate = localDateString(new Date(far.startUtc!), "Europe/Paris");
    expect(farDate < "2026-09-12").toBe(true); // pulled forward, before the blackout starts
  });
});

describe("scheduling engine: manual overrides", () => {
  it("never moves a LOCKED session even when new constraints appear", () => {
    const ev = makeSourceEvent();
    const config = baseConfig();
    const run1 = runScheduling(baseInput({ sourceEvents: [ev], config }));
    const nearId = findSession(run1.sessions, ev.canonicalId, "near").id;

    const lockOverride = makeOverride({ studySessionId: nearId, action: "LOCK", createdAt: "2026-09-02T00:00:00.000Z" });

    // Second run: lock applied. Also add a blocked period covering the whole
    // rest of the near window, to prove the lock is respected regardless.
    const run2 = runScheduling(
      baseInput({
        sourceEvents: [ev],
        config,
        overrides: [lockOverride],
        prevSessions: run1.sessions,
        blockedPeriods: [{ id: "b1", startUtc: "2026-01-01T00:00:00Z", endUtc: "2027-01-01T00:00:00Z", reason: "everything blocked" }],
      })
    );
    const locked = findSession(run2.sessions, ev.canonicalId, "near");
    const original = findSession(run1.sessions, ev.canonicalId, "near");
    expect(locked.status).toBe("LOCKED");
    expect(locked.startUtc).toBe(original.startUtc);
    expect(locked.hasManualOverride).toBe(true);
  });

  it("marks an orphaned locked session when its source class disappears, and it stays in place", () => {
    const ev = makeSourceEvent();
    const config = baseConfig();
    const run1 = runScheduling(baseInput({ sourceEvents: [ev], config }));
    const nearId = findSession(run1.sessions, ev.canonicalId, "near").id;
    const lockOverride = makeOverride({ studySessionId: nearId, action: "LOCK", createdAt: "2026-09-02T00:00:00.000Z" });
    const run2 = runScheduling(baseInput({ sourceEvents: [ev], config, overrides: [lockOverride], prevSessions: run1.sessions }));

    // Run 3: the source class is gone entirely from the feed.
    const run3 = runScheduling(
      baseInput({ sourceEvents: [], config, overrides: [lockOverride], prevSessions: run2.sessions })
    );
    const orphan = run3.sessions.find((s) => s.id === nearId)!;
    expect(orphan.status).toBe("LOCKED");
    expect(orphan.orphaned).toBe(true);
    expect(orphan.startUtc).toBe(findSession(run2.sessions, ev.canonicalId, "near").startUtc);
  });

  it("cancels a non-locked session whose source class disappears", () => {
    const ev = makeSourceEvent();
    const config = baseConfig();
    const run1 = runScheduling(baseInput({ sourceEvents: [ev], config }));
    const run2 = runScheduling(baseInput({ sourceEvents: [], config, prevSessions: run1.sessions }));
    const near = run2.sessions.find((s) => s.sourceCanonicalId === ev.canonicalId && s.reviewName === "near")!;
    expect(near.status).toBe("CANCELLED");
    expect(near.startUtc).toBeNull();
  });

  it("omits a SKIPPED session from placement and never re-proposes it", () => {
    const ev = makeSourceEvent();
    const config = baseConfig();
    const run1 = runScheduling(baseInput({ sourceEvents: [ev], config }));
    const nearId = findSession(run1.sessions, ev.canonicalId, "near").id;
    const skipOverride = makeOverride({ studySessionId: nearId, action: "SKIP", createdAt: "2026-09-02T00:00:00.000Z" });

    const run2 = runScheduling(baseInput({ sourceEvents: [ev], config, overrides: [skipOverride], prevSessions: run1.sessions }));
    const run3 = runScheduling(baseInput({ sourceEvents: [ev], config, overrides: [skipOverride], prevSessions: run2.sessions }));

    for (const run of [run2, run3]) {
      const near = findSession(run.sessions, ev.canonicalId, "near");
      expect(near.status).toBe("SKIPPED");
      expect(near.startUtc).toBeNull();
    }
  });

  it("UNLOCK reverts a session to normal auto-scheduling", () => {
    const ev = makeSourceEvent();
    const config = baseConfig();
    const run1 = runScheduling(baseInput({ sourceEvents: [ev], config }));
    const nearId = findSession(run1.sessions, ev.canonicalId, "near").id;
    const lock = makeOverride({ studySessionId: nearId, action: "LOCK", createdAt: "2026-09-02T00:00:00.000Z" });
    const run2 = runScheduling(baseInput({ sourceEvents: [ev], config, overrides: [lock], prevSessions: run1.sessions }));
    const unlock = makeOverride({ studySessionId: nearId, action: "UNLOCK", createdAt: "2026-09-03T00:00:00.000Z" });
    const run3 = runScheduling(baseInput({ sourceEvents: [ev], config, overrides: [lock, unlock], prevSessions: run2.sessions }));
    const near = findSession(run3.sessions, ev.canonicalId, "near");
    expect(near.status).toBe("SCHEDULED");
    expect(near.hasManualOverride).toBe(false);
  });
});

describe("scheduling engine: determinism", () => {
  it("produces identical placements given identical inputs (idempotent, no randomness)", () => {
    const ev1 = makeSourceEvent({ canonicalId: "c1" });
    const ev2 = makeSourceEvent({ canonicalId: "c2", startUtc: "2026-09-09T07:00:00.000Z", endUtc: "2026-09-09T09:00:00.000Z" });
    const config = baseConfig();
    const input = baseInput({ sourceEvents: [ev1, ev2], config });
    const run1 = runScheduling(input);
    const run2 = runScheduling(input);
    const strip = (s: StudySession) => ({ ...s, createdAt: "", updatedAt: "" });
    expect(run1.sessions.map(strip)).toEqual(run2.sessions.map(strip));
  });

  it("keeps stable ids across runs (study-{canonicalId}-{reviewName})", () => {
    const ev = makeSourceEvent();
    const { sessions } = runScheduling(baseInput({ sourceEvents: [ev] }));
    const near = findSession(sessions, ev.canonicalId, "near");
    expect(near.id).toBe(`study-${ev.canonicalId}-near`);
  });
});
