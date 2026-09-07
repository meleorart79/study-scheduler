import type { Config, TimeWindow } from "../types.js";
import { isWeekend, zonedTimeToUtc, parseHHmm } from "../util/timezone.js";

export interface Interval {
  startMs: number;
  endMs: number;
}

export interface Candidate {
  date: string; // local date "YYYY-MM-DD"
  startUtc: Date;
  endUtc: Date;
}

/** Windows applicable to a given local date, per weekday/weekend config. */
export function windowsForDate(dateStr: string, config: Config): TimeWindow[] {
  const midday = midpointUtcForDate(dateStr, config.timezone);
  return isWeekend(midday, config.timezone)
    ? config.studyWindows.weekends
    : config.studyWindows.weekdays;
}

function midpointUtcForDate(dateStr: string, timezone: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return zonedTimeToUtc(y!, m!, d!, 12, 0, 0, timezone);
}

/**
 * Generates every 15-minute-grid-aligned candidate start time on `dateStr`
 * that fits entirely inside one of the applicable study windows.
 */
export function generateCandidatesForDate(dateStr: string, config: Config): Candidate[] {
  const windows = windowsForDate(dateStr, config);
  const { blockMinutes, sessionMinutes } = config.grid;
  const [y, m, d] = dateStr.split("-").map(Number);

  const out: Candidate[] = [];
  for (const w of windows) {
    const start = parseHHmm(w.start);
    const end = parseHHmm(w.end);
    const windowStartUtc = zonedTimeToUtc(y!, m!, d!, start.h, start.m, 0, config.timezone);
    const windowEndUtc = zonedTimeToUtc(y!, m!, d!, end.h, end.m, 0, config.timezone);

    let cursor = windowStartUtc.getTime();
    const windowEndMs = windowEndUtc.getTime();
    while (cursor + sessionMinutes * 60_000 <= windowEndMs) {
      out.push({
        date: dateStr,
        startUtc: new Date(cursor),
        endUtc: new Date(cursor + sessionMinutes * 60_000),
      });
      cursor += blockMinutes * 60_000;
    }
  }
  return out;
}

export function toInterval(startUtc: Date | string, endUtc: Date | string): Interval {
  return {
    startMs: new Date(startUtc).getTime(),
    endMs: new Date(endUtc).getTime(),
  };
}

/** True if [a] and [b] overlap or are closer than `bufferMinutes` apart. */
export function tooClose(a: Interval, b: Interval, bufferMinutes: number): boolean {
  const bufferMs = bufferMinutes * 60_000;
  return a.startMs < b.endMs + bufferMs && b.startMs < a.endMs + bufferMs;
}

/** True if [a] and [b] overlap at all (zero-buffer / strict containment check). */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}
