import { describe, expect, it } from "vitest";
import fixture from "./fixtures/hyperplanning-uspn-schedule.json" with { type: "json" };
import {
  decodeHyperplanningSchedule,
  decodePeriodPosition,
  parseCompactIntList,
} from "../src/hyperplanning/decoder.js";

describe("Hyperplanning USPN decoder", () => {
  it("parses compact week ranges without guessing missing values", () => {
    expect(parseCompactIntList("[4..6,8,12..13]")).toEqual([4, 5, 6, 8, 12, 13]);
  });

  it("decodes p/d as a 52-slot 15-minute grid starting at 08:00", () => {
    expect(decodePeriodPosition(30, 6)).toEqual({
      dayIndex: 0,
      startMinutes: 15 * 60 + 30,
      endMinutes: 17 * 60,
    });
    expect(decodePeriodPosition(121, 6)).toEqual({
      dayIndex: 2,
      startMinutes: 12 * 60 + 15,
      endMinutes: 13 * 60 + 45,
    });
  });

  it("expands dom weeks into concrete Europe/Paris occurrences", () => {
    const result = decodeHyperplanningSchedule(fixture, {
      academicWeek1Monday: "2026-08-17",
      timezone: "Europe/Paris",
    });

    const algebraTd = result.events.filter(e => e.summary === "Algebre 1 (G1MAAL1) (TD)");
    expect(algebraTd).toHaveLength(2);
    expect(algebraTd.map(e => [e.startUtc, e.endUtc])).toEqual([
      ["2026-09-14T13:30:00.000Z", "2026-09-14T15:00:00.000Z"],
      ["2026-09-21T13:30:00.000Z", "2026-09-21T15:00:00.000Z"],
    ]);

    const algebraCm = result.events.find(e => e.summary === "Algebre 1 (G1MAAL1) (CM)");
    expect(algebraCm).toMatchObject({
      startUtc: "2026-09-09T10:15:00.000Z",
      endUtc: "2026-09-09T11:45:00.000Z",
      location: "Amphi Claudine Hermann (D)",
    });

    expect(result.events.some(e => e.uid.includes("placeholder"))).toBe(false);
    expect(result.courseCount).toBe(4);
    expect(result.expandedOccurrenceCount).toBe(result.events.length);
  });

  it("rejects malformed date position instead of inventing a decoding", () => {
    expect(() => decodePeriodPosition(392, 6)).toThrow(/outside Monday-Sunday/);
  });
});
