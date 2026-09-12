import { createHash } from "node:crypto";
import type { BlockedPeriod, Config } from "../types.js";
import { addDaysToDateString, parseHHmm, utcToZonedParts, zonedTimeToUtc } from "../util/timezone.js";

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function weekdayIndexForDate(dateStr: string, timezone: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  // Noon pivot avoids any DST-transition ambiguity when reading back the weekday.
  const noonUtc = zonedTimeToUtc(y!, m!, d!, 12, 0, 0, timezone);
  return utcToZonedParts(noonUtc, timezone).weekday;
}

function makeId(startUtc: string, endUtc: string, reason: string): string {
  return `cfg-${createHash("sha1").update(`${startUtc}|${endUtc}|${reason}`).digest("hex").slice(0, 12)}`;
}

/**
 * Expands config.recurringBlockedPeriods (e.g. weekly basketball practice)
 * into concrete BlockedPeriod instants covering every day in
 * [rangeStartDate, rangeEndDate] (inclusive, local dates in config.timezone).
 */
function expandRecurringBlockedPeriods(
  config: Config,
  rangeStartDate: string,
  rangeEndDate: string
): BlockedPeriod[] {
  const rules = config.recurringBlockedPeriods;
  if (!rules || rules.length === 0) return [];

  const out: BlockedPeriod[] = [];
  let cur = rangeStartDate;
  let guard = 0;
  while (cur <= rangeEndDate && guard++ < 10_000) {
    const weekday = weekdayIndexForDate(cur, config.timezone);
    for (const rule of rules) {
      if (WEEKDAY_INDEX[rule.weekday] !== weekday) continue;
      const [y, m, d] = cur.split("-").map(Number);
      const start = parseHHmm(rule.start);
      const end = parseHHmm(rule.end);
      const startUtc = zonedTimeToUtc(y!, m!, d!, start.h, start.m, 0, config.timezone).toISOString();
      const endUtc = zonedTimeToUtc(y!, m!, d!, end.h, end.m, 0, config.timezone).toISOString();
      out.push({
        id: makeId(startUtc, endUtc, rule.reason),
        startUtc,
        endUtc,
        reason: rule.reason,
      });
    }
    cur = addDaysToDateString(cur, 1);
  }
  return out;
}

/**
 * Combines statically configured blockedPeriods with expanded
 * recurringBlockedPeriods across [rangeStartDate, rangeEndDate].
 */
export function blockedPeriodsFromConfig(
  config: Config,
  rangeStartDate: string,
  rangeEndDate: string
): BlockedPeriod[] {
  const staticPeriods = config.blockedPeriods.map((bp) => ({
    id: makeId(bp.startUtc, bp.endUtc, bp.reason),
    startUtc: bp.startUtc,
    endUtc: bp.endUtc,
    reason: bp.reason,
  }));
  const recurring = expandRecurringBlockedPeriods(config, rangeStartDate, rangeEndDate);
  return [...staticPeriods, ...recurring];
}
