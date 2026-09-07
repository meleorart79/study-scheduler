import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { runScheduling } from "../../src/scheduling/engine.js";
import { minutesOfDay, localDateString } from "../../src/util/timezone.js";
import { baseConfig, makeSourceEvent } from "../helpers.js";
import type { SchedulingInput } from "../../src/types.js";

const config = baseConfig();

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

describe("property: scheduling engine hard-constraint invariants", () => {
  it("never produces two placed intervals (study or class) closer than the buffer, and every study session fits its window", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100000 }), { minLength: 1, maxLength: 4 }),
        (seeds) => {
          const events = seeds.map((seed, i) => {
            // Deterministic pseudo-random-ish spread using the seed, avoiding a
            // second fast-check layer for simplicity while still varying inputs.
            const dayOffset = seed % 15;
            const hour = 7 + (seed % 12);
            const quarter = seed % 4;
            const durationBlocks = 1 + (seed % 6);
            const y = 2026, m = 9, d = 7 + dayOffset;
            const base = new Date(Date.UTC(y, m - 1, d, 5, 0, 0));
            const startIso = new Date(base.getTime() + (hour * 60 + quarter * 15) * 60_000).toISOString();
            const endIso = new Date(new Date(startIso).getTime() + durationBlocks * 15 * 60_000).toISOString();
            return makeSourceEvent({
              canonicalId: `prop-ev-${i}`,
              summary: `Class ${i}`,
              startUtc: startIso,
              endUtc: endIso,
            });
          });

          const input: SchedulingInput = {
            sourceEvents: events,
            assessments: [],
            config,
            overrides: [],
            blockedPeriods: [],
            prevSessions: [],
            nowUtc: "2026-09-01T00:00:00.000Z",
            runId: "prop-run",
          };

          const { sessions } = runScheduling(input);
          const placedStudy = sessions.filter((s) => s.startUtc && s.endUtc);

          // 1. Every placed study session fits entirely inside its day's applicable window.
          for (const s of placedStudy) {
            const startMin = minutesOfDay(new Date(s.startUtc!), config.timezone);
            const endMin = minutesOfDay(new Date(s.endUtc!), config.timezone);
            const date = localDateString(new Date(s.startUtc!), config.timezone);
            const dow = new Date(date + "T12:00:00Z").getUTCDay();
            const isWeekendDay = dow === 0 || dow === 6;
            const windows = isWeekendDay ? config.studyWindows.weekends : config.studyWindows.weekdays;
            const fitsSomeWindow = windows.some((w) => {
              const [wsh, wsm] = w.start.split(":").map(Number);
              const [weh, wem] = w.end.split(":").map(Number);
              const wStart = wsh! * 60 + wsm!;
              const wEnd = weh! * 60 + wem!;
              return startMin >= wStart && endMin <= wEnd;
            });
            expect(fitsSomeWindow).toBe(true);
          }

          // 2. No study session shares a calendar day with its own source class.
          for (const s of placedStudy) {
            const ev = events.find((e) => e.canonicalId === s.sourceCanonicalId)!;
            const ownDate = localDateString(new Date(ev.startUtc), config.timezone);
            const sessionDate = localDateString(new Date(s.startUtc!), config.timezone);
            expect(sessionDate).not.toBe(ownDate);
          }

          // 3. No two study sessions overlap or violate the buffer against each
          //    other or against any class.
          const allIntervals: { start: number; end: number; kind: string }[] = [
            ...events.map((e) => ({ start: new Date(e.startUtc).getTime(), end: new Date(e.endUtc).getTime(), kind: "class" })),
            ...placedStudy.map((s) => ({ start: new Date(s.startUtc!).getTime(), end: new Date(s.endUtc!).getTime(), kind: "study" })),
          ];
          const bufferMs = config.grid.minBufferMinutes * 60_000;
          for (let i = 0; i < allIntervals.length; i++) {
            for (let j = i + 1; j < allIntervals.length; j++) {
              const a = allIntervals[i]!;
              const b = allIntervals[j]!;
              if (a.kind === "class" && b.kind === "class") continue; // classes may legitimately be adjacent/overlap in input
              const tooClose = overlaps(a.start - bufferMs, a.end + bufferMs, b.start, b.end);
              expect(tooClose).toBe(false);
            }
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
