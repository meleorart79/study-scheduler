import { describe, it, expect } from "vitest";
import { generateCandidatesForDate, windowsForDate } from "../src/scheduling/candidates.js";
import { minutesOfDay } from "../src/util/timezone.js";
import { baseConfig } from "./helpers.js";

const config = baseConfig();

describe("candidate generation: weekday window", () => {
  const monday = "2026-09-07"; // Monday
  const candidates = generateCandidatesForDate(monday, config);

  it("never starts before 11:30 or ends after 21:00 local", () => {
    for (const c of candidates) {
      const startMin = minutesOfDay(c.startUtc, config.timezone);
      const endMin = minutesOfDay(c.endUtc, config.timezone);
      expect(startMin).toBeGreaterThanOrEqual(11 * 60 + 30);
      expect(endMin).toBeLessThanOrEqual(21 * 60);
    }
  });

  it("covers the window on a 15-minute grid, 90-minute sessions", () => {
    // 11:30 to 21:00 = 570 minutes; last start = 21:00 - 90 = 19:30.
    // Number of 15-min-aligned starts from 11:30 to 19:30 inclusive = (19:30-11:30)/15 + 1 = 33
    expect(candidates.length).toBe(33);
    expect(minutesOfDay(candidates[0]!.startUtc, config.timezone)).toBe(11 * 60 + 30);
    expect(minutesOfDay(candidates[candidates.length - 1]!.startUtc, config.timezone)).toBe(19 * 60 + 30);
  });
});

describe("candidate generation: weekend windows", () => {
  const saturday = "2026-09-12"; // Saturday
  const candidates = generateCandidatesForDate(saturday, config);

  it("only places sessions inside 10:00-14:00 or 20:00-22:00, never the 14:00-20:00 gap", () => {
    for (const c of candidates) {
      const startMin = minutesOfDay(c.startUtc, config.timezone);
      const endMin = minutesOfDay(c.endUtc, config.timezone);
      const inMorning = startMin >= 10 * 60 && endMin <= 14 * 60;
      const inEvening = startMin >= 20 * 60 && endMin <= 22 * 60;
      expect(inMorning || inEvening).toBe(true);
    }
  });

  it("never crosses the 14:00-20:00 gap or midnight", () => {
    for (const c of candidates) {
      const startMin = minutesOfDay(c.startUtc, config.timezone);
      const endMin = minutesOfDay(c.endUtc, config.timezone);
      expect(startMin < 14 * 60 || startMin >= 20 * 60).toBe(true);
      expect(endMin).toBeGreaterThan(startMin); // never crosses midnight (same-day arithmetic)
    }
  });

  it("the 20:00-22:00 window fits exactly one 90-minute session start point range", () => {
    const eveningStarts = candidates
      .map((c) => minutesOfDay(c.startUtc, config.timezone))
      .filter((m) => m >= 20 * 60);
    // 20:00 to 22:00 = 120 min; last start = 22:00-90 = 20:30. Starts: 20:00, 20:15, 20:30 => 3
    expect(eveningStarts.sort((a, b) => a - b)).toEqual([20 * 60, 20 * 60 + 15, 20 * 60 + 30]);
  });

  it("correctly identifies Sunday as a weekend day too", () => {
    const windows = windowsForDate("2026-09-13", config);
    expect(windows).toEqual(config.studyWindows.weekends);
  });

  it("correctly identifies weekdays as using the weekday window set", () => {
    const windows = windowsForDate("2026-09-08", config); // Tuesday
    expect(windows).toEqual(config.studyWindows.weekdays);
  });
});
