import { describe, it, expect } from "vitest";
import { detectClassType, extractSubject, buildPendingReviews } from "../src/scheduling/classType.js";
import { runScheduling } from "../src/scheduling/engine.js";
import { baseConfig, makeSourceEvent } from "./helpers.js";
import type { SchedulingInput } from "../src/types.js";

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

describe("classType: detection and subject extraction", () => {
  const config = baseConfig();

  it("detects CM/TD/TP tags", () => {
    expect(detectClassType("Algorithms (CM)", config)).toBe("CM");
    expect(detectClassType("Algorithms (TD)", config)).toBe("TD");
    expect(detectClassType("Algorithms (TP)", config)).toBe("TP");
    expect(detectClassType("Algorithms Lecture", config)).toBeNull();
  });

  it("strips the tag to produce a stable subject key", () => {
    expect(extractSubject("Algorithms (TP)", config)).toBe("Algorithms");
    expect(extractSubject("Algorithms (TD)", config)).toBe("Algorithms");
    expect(extractSubject("Algorithms", config)).toBe("Algorithms");
  });
});

describe("classType: buildPendingReviews", () => {
  it("legacy behavior when classTypeReviews.enabled is false: every event gets every review", () => {
    const config = baseConfig((c) => {
      c.classTypeReviews.enabled = false;
    });
    const ev = makeSourceEvent({ summary: "Algorithms (TD)" });
    const pending = buildPendingReviews([ev], config);
    expect(pending.map((p) => p.id).sort()).toEqual(
      [`study-${ev.canonicalId}-near`, `study-${ev.canonicalId}-far`].sort()
    );
  });

  it("CM (or untagged) class gets every configured review", () => {
    const config = baseConfig();
    const cm = makeSourceEvent({ summary: "Algorithms (CM)" });
    const untagged = makeSourceEvent({ canonicalId: "se-untagged", summary: "Algorithms Lecture" });
    const pending = buildPendingReviews([cm, untagged], config);
    expect(pending.filter((p) => p.ev.canonicalId === cm.canonicalId)).toHaveLength(2);
    expect(pending.filter((p) => p.ev.canonicalId === untagged.canonicalId)).toHaveLength(2);
  });

  it("TD class gets only the near review", () => {
    const config = baseConfig();
    const td = makeSourceEvent({ summary: "Algorithms (TD)" });
    const pending = buildPendingReviews([td], config);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(`study-${td.canonicalId}-near`);
  });

  it("2 TP classes of the same subject share exactly 1 review, anchored on the 2nd", () => {
    const config = baseConfig();
    const tp1 = makeSourceEvent({
      canonicalId: "tp-1",
      summary: "Databases (TP)",
      startUtc: "2026-09-08T07:00:00.000Z",
      endUtc: "2026-09-08T09:00:00.000Z",
    });
    const tp2 = makeSourceEvent({
      canonicalId: "tp-2",
      summary: "Databases (TP)",
      startUtc: "2026-09-15T07:00:00.000Z",
      endUtc: "2026-09-15T09:00:00.000Z",
    });
    const pending = buildPendingReviews([tp1, tp2], config);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.ev.canonicalId).toBe("tp-2"); // anchored on the 2nd of the pair
    expect(pending[0]!.id).toBe("study-tp-2-near");
  });

  it("an odd trailing TP occurrence gets its own review immediately, anchored on itself", () => {
    const config = baseConfig();
    const tp1 = makeSourceEvent({
      canonicalId: "tp-1",
      summary: "Databases (TP)",
      startUtc: "2026-09-08T07:00:00.000Z",
      endUtc: "2026-09-08T09:00:00.000Z",
    });
    const tp2 = makeSourceEvent({
      canonicalId: "tp-2",
      summary: "Databases (TP)",
      startUtc: "2026-09-15T07:00:00.000Z",
      endUtc: "2026-09-15T09:00:00.000Z",
    });
    const tp3 = makeSourceEvent({
      canonicalId: "tp-3",
      summary: "Databases (TP)",
      startUtc: "2026-09-22T07:00:00.000Z",
      endUtc: "2026-09-22T09:00:00.000Z",
    });
    const pending = buildPendingReviews([tp1, tp2, tp3], config);
    // (tp1,tp2) pair -> anchored on tp2; tp3 leftover -> anchored on itself.
    expect(pending.map((p) => p.ev.canonicalId).sort()).toEqual(["tp-2", "tp-3"].sort());
  });

  it("TP pairing is scoped per subject -- different subjects never pair with each other", () => {
    const config = baseConfig();
    const algoTp = makeSourceEvent({ canonicalId: "algo-tp", summary: "Algorithms (TP)" });
    const dbTp = makeSourceEvent({ canonicalId: "db-tp", summary: "Databases (TP)" });
    const pending = buildPendingReviews([algoTp, dbTp], config);
    // Each subject only has 1 TP occurrence -> each is its own leftover, each gets a review.
    expect(pending.map((p) => p.ev.canonicalId).sort()).toEqual(["algo-tp", "db-tp"].sort());
  });
});

describe("classType: integrated with the scheduling engine", () => {
  it("CM class ends up with 2 scheduled review sessions", () => {
    const ev = makeSourceEvent({ summary: "Algorithms (CM)" });
    const { sessions } = runScheduling(baseInput({ sourceEvents: [ev] }));
    const forEv = sessions.filter((s) => s.sourceCanonicalId === ev.canonicalId);
    expect(forEv).toHaveLength(2);
    expect(forEv.map((s) => s.reviewName).sort()).toEqual(["far", "near"]);
  });

  it("TD class ends up with exactly 1 scheduled review session (near)", () => {
    const ev = makeSourceEvent({ summary: "Algorithms (TD)" });
    const { sessions } = runScheduling(baseInput({ sourceEvents: [ev] }));
    const forEv = sessions.filter((s) => s.sourceCanonicalId === ev.canonicalId);
    expect(forEv).toHaveLength(1);
    expect(forEv[0]!.reviewName).toBe("near");
  });

  it("2 TP classes of the same subject end up with exactly 1 scheduled review total", () => {
    const tp1 = makeSourceEvent({
      canonicalId: "tp-1",
      summary: "Databases (TP)",
      startUtc: "2026-09-08T07:00:00.000Z",
      endUtc: "2026-09-08T09:00:00.000Z",
    });
    const tp2 = makeSourceEvent({
      canonicalId: "tp-2",
      summary: "Databases (TP)",
      startUtc: "2026-09-15T07:00:00.000Z",
      endUtc: "2026-09-15T09:00:00.000Z",
    });
    const { sessions } = runScheduling(baseInput({ sourceEvents: [tp1, tp2] }));
    const forSubject = sessions.filter((s) => s.sourceCanonicalId === "tp-1" || s.sourceCanonicalId === "tp-2");
    expect(forSubject).toHaveLength(1);
    expect(forSubject[0]!.sourceCanonicalId).toBe("tp-2");
    expect(forSubject[0]!.status).toBe("SCHEDULED");
  });

  it("a TP class's review is cancelled/reassigned once a later same-subject TP arrives and shifts the anchor", () => {
    const tp1 = makeSourceEvent({
      canonicalId: "tp-1",
      summary: "Databases (TP)",
      startUtc: "2026-09-08T07:00:00.000Z",
      endUtc: "2026-09-08T09:00:00.000Z",
    });
    const run1 = runScheduling(baseInput({ sourceEvents: [tp1] }));
    const firstReview = run1.sessions.find((s) => s.sourceCanonicalId === "tp-1")!;
    expect(firstReview.status).toBe("SCHEDULED"); // leftover -> gets its own review immediately

    const tp2 = makeSourceEvent({
      canonicalId: "tp-2",
      summary: "Databases (TP)",
      startUtc: "2026-09-15T07:00:00.000Z",
      endUtc: "2026-09-15T09:00:00.000Z",
    });
    const run2 = runScheduling(
      baseInput({ sourceEvents: [tp1, tp2], prevSessions: run1.sessions })
    );
    const stillOnTp1 = run2.sessions.find((s) => s.id === firstReview.id)!;
    expect(stillOnTp1.status).toBe("CANCELLED"); // anchor moved to tp2
    const onTp2 = run2.sessions.find((s) => s.sourceCanonicalId === "tp-2")!;
    expect(onTp2.status).toBe("SCHEDULED");
  });
});
