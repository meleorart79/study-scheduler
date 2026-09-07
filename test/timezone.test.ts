import { describe, it, expect } from "vitest";
import {
  zonedTimeToUtc,
  utcToZonedParts,
  isWeekend,
  localDateString,
  addDaysToDateString,
  minutesOfDay,
} from "../src/util/timezone.js";

describe("timezone utils", () => {
  it("converts a Europe/Paris winter time (CET, UTC+1) correctly", () => {
    const d = zonedTimeToUtc(2026, 1, 15, 12, 0, 0, "Europe/Paris");
    expect(d.toISOString()).toBe("2026-01-15T11:00:00.000Z");
  });

  it("converts a Europe/Paris summer time (CEST, UTC+2) correctly", () => {
    const d = zonedTimeToUtc(2026, 7, 15, 12, 0, 0, "Europe/Paris");
    expect(d.toISOString()).toBe("2026-07-15T10:00:00.000Z");
  });

  it("round-trips through utcToZonedParts", () => {
    const d = zonedTimeToUtc(2026, 3, 10, 9, 30, 0, "Europe/Paris");
    const parts = utcToZonedParts(d, "Europe/Paris");
    expect(parts).toMatchObject({ year: 2026, month: 3, day: 10, hour: 9, minute: 30 });
  });

  it("handles the DST spring-forward transition (2026-03-29 in Europe/Paris)", () => {
    // At 02:00 local time clocks jump to 03:00. 09:00 local both before and
    // after should still resolve to a valid, monotonically-increasing UTC
    // instant across the boundary.
    const before = zonedTimeToUtc(2026, 3, 28, 9, 0, 0, "Europe/Paris");
    const after = zonedTimeToUtc(2026, 3, 30, 9, 0, 0, "Europe/Paris");
    expect(after.getTime()).toBeGreaterThan(before.getTime());
    // Before: UTC+1 => 08:00Z. After: UTC+2 => 07:00Z.
    expect(before.toISOString()).toBe("2026-03-28T08:00:00.000Z");
    expect(after.toISOString()).toBe("2026-03-30T07:00:00.000Z");
  });

  it("handles the DST fall-back transition (2026-10-25 in Europe/Paris)", () => {
    const before = zonedTimeToUtc(2026, 10, 24, 9, 0, 0, "Europe/Paris");
    const after = zonedTimeToUtc(2026, 10, 26, 9, 0, 0, "Europe/Paris");
    expect(before.toISOString()).toBe("2026-10-24T07:00:00.000Z");
    expect(after.toISOString()).toBe("2026-10-26T08:00:00.000Z");
  });

  it("identifies weekends correctly in a given timezone", () => {
    const saturday = zonedTimeToUtc(2026, 9, 12, 12, 0, 0, "Europe/Paris");
    const monday = zonedTimeToUtc(2026, 9, 14, 12, 0, 0, "Europe/Paris");
    expect(isWeekend(saturday, "Europe/Paris")).toBe(true);
    expect(isWeekend(monday, "Europe/Paris")).toBe(false);
  });

  it("localDateString/addDaysToDateString are consistent", () => {
    expect(addDaysToDateString("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDaysToDateString("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("minutesOfDay reflects local wall clock, not UTC", () => {
    const d = zonedTimeToUtc(2026, 7, 1, 14, 30, 0, "Europe/Paris"); // CEST, UTC+2
    expect(minutesOfDay(d, "Europe/Paris")).toBe(14 * 60 + 30);
  });
});
