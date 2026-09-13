import type { Config, SourceEvent } from "../types.js";
import { localDateString } from "../util/timezone.js";

const weightRegexCache = new Map<string, RegExp>();

function getWeightRegex(pattern: string): RegExp {
  let re = weightRegexCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern, "i");
    weightRegexCache.set(pattern, re);
  }
  return re;
}

/**
 * Weight multiplier for a source event based on config.classWeighting.rules,
 * matched (case-insensitively) against "{summary} {location}". The first
 * matching rule wins; falls back to defaultWeight (typically 1.0). This lets
 * e.g. TD/TP sessions count as half (or less) of a CM lecture's class-load
 * for the purposes of classLoadAdjustment below.
 */
export function classWeightForEvent(ev: SourceEvent, config: Config): number {
  const haystack = `${ev.summary} ${ev.location ?? ""}`;
  for (const rule of config.classWeighting.rules) {
    if (getWeightRegex(rule.pattern).test(haystack)) return rule.weight;
  }
  return config.classWeighting.defaultWeight;
}

/** Total *weighted* minutes of class time on a given local date, keyed "YYYY-MM-DD". */
export function computeClassMinutesByDate(
  sourceEvents: SourceEvent[],
  timezone: string,
  config: Config
): Map<string, number> {
  const map = new Map<string, number>();
  for (const ev of sourceEvents) {
    const date = localDateString(new Date(ev.startUtc), timezone);
    const rawMinutes =
      (new Date(ev.endUtc).getTime() - new Date(ev.startUtc).getTime()) / 60_000;
    const minutes = rawMinutes * classWeightForEvent(ev, config);
    map.set(date, (map.get(date) ?? 0) + minutes);
  }
  return map;
}

/**
 *   effectivePreferred(day) = max(floor, preferred - classMinutes*(reducedPerHour/60))
 *   effectiveMax(day)       = max(floor, max - classMinutes*(reducedPerHour/60))
 *
 * classMinutes here is already weighted (see computeClassMinutesByDate).
 */
export function effectivePreferredMinutes(
  classMinutesOnDay: number,
  config: Config
): number {
  const { preferredDailyMinutes, classLoadAdjustment } = config.workload;
  if (!classLoadAdjustment.enabled) return preferredDailyMinutes;
  const reduction = classMinutesOnDay * (classLoadAdjustment.minutesReducedPerClassHour / 60);
  return Math.max(classLoadAdjustment.floorMinutes, preferredDailyMinutes - reduction);
}

/**
 * Returns Infinity (no cap) when maxDailyMinutes is null. Otherwise the
 * usual classLoadAdjustment-reduced cap. classLoadAdjustment still shrinks
 * effectivePreferredMinutes (the soft ranking preference) regardless — it
 * only stops acting as a hard wall once maxDailyMinutes is null.
 */
export function effectiveMaxMinutes(classMinutesOnDay: number, config: Config): number {
    const { maxDailyMinutes, classLoadAdjustment } = config.workload;
    if (maxDailyMinutes === null) return Infinity;
    if (!classLoadAdjustment.enabled) return maxDailyMinutes;
    const reduction = classMinutesOnDay * (classLoadAdjustment.minutesReducedPerClassHour / 60);
    return Math.max(classLoadAdjustment.floorMinutes, maxDailyMinutes - reduction);
}