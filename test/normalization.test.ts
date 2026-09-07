import { describe, it, expect } from "vitest";
import { normalizeSourceEvents } from "../src/normalization/normalize.js";
import type { RawNormalizedEvent } from "../src/ics-input/types.js";

function raw(overrides: Partial<RawNormalizedEvent> = {}): RawNormalizedEvent {
  return {
    uid: "uid-1",
    recurrenceKey: null,
    summary: "Algorithms Lecture",
    startUtc: new Date("2026-09-10T09:00:00.000Z"),
    endUtc: new Date("2026-09-10T11:00:00.000Z"),
    sourceTimezone: "Europe/Paris",
    wasFloating: false,
    location: null,
    ...overrides,
  };
}

describe("normalization", () => {
  it("produces a stable canonicalId for the same content across runs", () => {
    const run1 = normalizeSourceEvents([raw()], [], "2026-09-01T00:00:00Z", "run-1");
    const run2 = normalizeSourceEvents([raw()], run1, "2026-09-02T00:00:00Z", "run-2");
    expect(run1[0]!.canonicalId).toBe(run2[0]!.canonicalId);
  });

  it("preserves firstSeenAt across runs for the same canonical event", () => {
    const run1 = normalizeSourceEvents([raw()], [], "2026-09-01T00:00:00Z", "run-1");
    const run2 = normalizeSourceEvents([raw()], run1, "2026-09-05T00:00:00Z", "run-2");
    expect(run2[0]!.firstSeenAt).toBe("2026-09-01T00:00:00Z");
    expect(run2[0]!.lastSeenRunId).toBe("run-2");
  });

  it("survives UID churn: same content, different raw UID -> same canonicalId", () => {
    const run1 = normalizeSourceEvents([raw({ uid: "old-uid-123" })], [], "2026-09-01T00:00:00Z", "run-1");
    const run2 = normalizeSourceEvents(
      [raw({ uid: "brand-new-uid-999" })],
      run1,
      "2026-09-08T00:00:00Z",
      "run-2"
    );
    expect(run2[0]!.canonicalId).toBe(run1[0]!.canonicalId);
    expect(run2[0]!.rawUid).toBe("brand-new-uid-999");
    expect(run2[0]!.firstSeenAt).toBe("2026-09-01T00:00:00Z");
  });

  it("gives a different canonicalId to a class that moved to a materially different time", () => {
    const run1 = normalizeSourceEvents([raw()], [], "2026-09-01T00:00:00Z", "run-1");
    const moved = raw({ startUtc: new Date("2026-09-10T13:00:00.000Z"), endUtc: new Date("2026-09-10T15:00:00.000Z") });
    const run2 = normalizeSourceEvents([moved], run1, "2026-09-08T00:00:00Z", "run-2");
    expect(run2[0]!.canonicalId).not.toBe(run1[0]!.canonicalId);
  });

  it("normalizes summary casing/whitespace so cosmetic changes don't create a new id", () => {
    const run1 = normalizeSourceEvents([raw({ summary: "Algorithms Lecture" })], [], "2026-09-01T00:00:00Z", "run-1");
    const run2 = normalizeSourceEvents(
      [raw({ summary: "  algorithms   lecture  " })],
      run1,
      "2026-09-02T00:00:00Z",
      "run-2"
    );
    expect(run2[0]!.canonicalId).toBe(run1[0]!.canonicalId);
  });

  it("deduplicates true content duplicates within a single feed pull", () => {
    const result = normalizeSourceEvents([raw({ uid: "a" }), raw({ uid: "b" })], [], "2026-09-01T00:00:00Z", "run-1");
    expect(result).toHaveLength(1);
  });
});
