import { describe, it, expect } from "vitest";
import { generateCandidatesForDate, windowsForDate } from "../src/scheduling/candidates.js";
import { minutesOfDay } from "../src/util/timezone.js";
import { baseConfig } from "./helpers.js";

const config = baseConfig();

describe("candidate generation: weekday windows", () => {
    const monday = "2026-09-07"; // Monday
    const candidates = generateCandidatesForDate(monday, config);

    it("stays within 08:30-11:45 or 12:30-23:45, never the 11:45-12:30 lunch gap", () => {
        for (const c of candidates) {
            const startMin = minutesOfDay(c.startUtc, config.timezone);
            const endMin = minutesOfDay(c.endUtc, config.timezone);
            const inMorning = startMin >= 8 * 60 + 30 && endMin <= 11 * 60 + 45;
            const inAfternoon = startMin >= 12 * 60 + 30 && endMin <= 23 * 60 + 45;
            expect(inMorning || inAfternoon).toBe(true);
        }
    });

    it("covers both weekday windows on a 15-minute grid, 90-minute sessions", () => {
        // 08:30-11:45 = 195 min, last start 10:15 -> 8 starts.
        // 12:30-23:45 = 675 min, last start 22:15 -> 40 starts.
        expect(candidates.length).toBe(48);
        expect(minutesOfDay(candidates[0]!.startUtc, config.timezone)).toBe(8 * 60 + 30);
        expect(minutesOfDay(candidates[candidates.length - 1]!.startUtc, config.timezone)).toBe(22 * 60 + 15);
    });
});

describe("candidate generation: weekend windows", () => {
    const saturday = "2026-09-12"; // Saturday
    const candidates = generateCandidatesForDate(saturday, config);

    it("only places sessions inside 08:00-12:00 or 16:00-23:45, never the 12:00-16:00 gap", () => {
        for (const c of candidates) {
            const startMin = minutesOfDay(c.startUtc, config.timezone);
            const endMin = minutesOfDay(c.endUtc, config.timezone);
            const inMorning = startMin >= 8 * 60 && endMin <= 12 * 60;
            const inEvening = startMin >= 16 * 60 && endMin <= 23 * 60 + 45;
            expect(inMorning || inEvening).toBe(true);
        }
    });

    it("never crosses the 12:00-16:00 gap or midnight", () => {
        for (const c of candidates) {
            const startMin = minutesOfDay(c.startUtc, config.timezone);
            const endMin = minutesOfDay(c.endUtc, config.timezone);
            expect(startMin < 12 * 60 || startMin >= 16 * 60).toBe(true);
            expect(endMin).toBeGreaterThan(startMin);
        }
    });

    it("the 16:00-23:45 window fits 26 fifteen-minute-aligned starts", () => {
        const eveningStarts = candidates
            .map((c) => minutesOfDay(c.startUtc, config.timezone))
            .filter((m) => m >= 16 * 60);
        expect(eveningStarts.length).toBe(26);
        expect(Math.min(...eveningStarts)).toBe(16 * 60);
        expect(Math.max(...eveningStarts)).toBe(22 * 60 + 15);
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