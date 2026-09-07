import type { TimeValue } from "./lowlevel.js";
import { addDaysToDateString } from "../util/timezone.js";

export interface RRuleSpec {
  freq: "DAILY" | "WEEKLY" | "UNSUPPORTED";
  interval: number;
  byday: number[] | null; // 0=Sun..6=Sat
  count: number | null;
  until: TimeValue | null;
}

const DAY_CODE: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

export function parseRRule(raw: string): RRuleSpec {
  const parts = Object.fromEntries(
    raw.split(";").map((seg) => {
      const [k, v] = seg.split("=");
      return [(k ?? "").toUpperCase(), v ?? ""];
    })
  );

  const freqRaw = (parts["FREQ"] ?? "").toUpperCase();
  const freq: RRuleSpec["freq"] =
    freqRaw === "DAILY" || freqRaw === "WEEKLY" ? (freqRaw as "DAILY" | "WEEKLY") : "UNSUPPORTED";

  const interval = parts["INTERVAL"] ? Math.max(1, parseInt(parts["INTERVAL"], 10)) : 1;
  const count = parts["COUNT"] ? parseInt(parts["COUNT"], 10) : null;

  let byday: number[] | null = null;
  if (parts["BYDAY"]) {
    byday = parts["BYDAY"]
      .split(",")
      .map((code) => DAY_CODE[code.trim().slice(-2).toUpperCase()])
      .filter((n): n is number => n !== undefined);
  }

  let until: TimeValue | null = null;
  if (parts["UNTIL"]) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(
      parts["UNTIL"]
    );
    if (m) {
      until = {
        kind: m[7] ? "utc" : "date-only",
        tzid: null,
        y: Number(m[1]),
        m: Number(m[2]),
        d: Number(m[3]),
        h: Number(m[4] ?? 0),
        mi: Number(m[5] ?? 0),
        s: Number(m[6] ?? 0),
      };
    }
  }

  return { freq, interval, byday, count, until };
}

/**
 * Generates candidate local dates ("YYYY-MM-DD") for a DAILY/WEEKLY RRULE
 * anchored at `dtstartDate`, bounded by [rangeStartDate, rangeEndDate]
 * (inclusive, both "YYYY-MM-DD"). The actual wall-clock time of day is
 * applied by the caller (it's constant across occurrences).
 *
 * A hard iteration cap guards against pathological input.
 */
export function expandRRuleDates(
  spec: RRuleSpec,
  dtstartDate: string,
  rangeStartDate: string,
  rangeEndDate: string
): string[] {
  if (spec.freq === "UNSUPPORTED") {
    return dtstartDate >= rangeStartDate && dtstartDate <= rangeEndDate
      ? [dtstartDate]
      : [];
  }

  const untilDate = spec.until
    ? `${pad4(spec.until.y)}-${pad2(spec.until.m)}-${pad2(spec.until.d)}`
    : null;

  const results: string[] = [];
  const MAX_ITER = 5000;
  let iter = 0;
  let occurrenceCount = 0;

  if (spec.freq === "DAILY") {
    let cursor = dtstartDate;
    while (iter++ < MAX_ITER) {
      if (untilDate && cursor > untilDate) break;
      if (spec.count !== null && occurrenceCount >= spec.count) break;
      if (cursor >= rangeStartDate && cursor <= rangeEndDate) {
        if (!(untilDate && cursor > untilDate)) results.push(cursor);
      }
      occurrenceCount++;
      if (cursor > rangeEndDate && (!untilDate || cursor > untilDate)) {
        if (spec.count === null) break;
      }
      if (cursor > rangeEndDate && spec.count === null) break;
      cursor = addDaysToDateString(cursor, spec.interval);
    }
    return results;
  }

  // WEEKLY
  const days = spec.byday && spec.byday.length > 0 ? spec.byday : null;
  let weekStart = startOfWeek(dtstartDate); // Monday-based week containing dtstart
  const dtstartDow = dowOf(dtstartDate);

  while (iter++ < MAX_ITER) {
    const candidateDows = days ?? [dtstartDow];
    // Emit in weekday order (Mon..Sun) for determinism.
    const ordered = [...candidateDows].sort((a, b) => mondayIndex(a) - mondayIndex(b));
    let emittedThisWeek = false;
    for (const dow of ordered) {
      const date = addDaysToDateString(weekStart, mondayIndex(dow));
      if (date < dtstartDate) continue; // series hasn't started yet
      if (untilDate && date > untilDate) continue;
      if (spec.count !== null && occurrenceCount >= spec.count) continue;
      occurrenceCount++;
      emittedThisWeek = true;
      if (date >= rangeStartDate && date <= rangeEndDate) results.push(date);
    }
    const stopByUntil = untilDate && weekStart > untilDate;
    const stopByCount = spec.count !== null && occurrenceCount >= spec.count;
    const stopByRange = weekStart > rangeEndDate;
    if (stopByUntil || stopByCount || stopByRange) break;
    if (!emittedThisWeek && weekStart > rangeEndDate) break;
    weekStart = addDaysToDateString(weekStart, 7 * spec.interval);
  }

  results.sort();
  return results;
}

function mondayIndex(dow: number): number {
  // Convert Sun=0..Sat=6 into Mon=0..Sun=6 offset from Monday.
  return (dow + 6) % 7;
}

function dowOf(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

function startOfWeek(dateStr: string): string {
  const dow = dowOf(dateStr);
  return addDaysToDateString(dateStr, -mondayIndex(dow));
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
function pad4(n: number): string {
  return n.toString().padStart(4, "0");
}
