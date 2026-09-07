import type { Config, SourceEvent } from "../types.js";
import { localDateString } from "../util/timezone.js";

/** Total minutes of class time on a given local date, keyed "YYYY-MM-DD". */
export function computeClassMinutesByDate(
  sourceEvents: SourceEvent[],
  timezone: string
): Map<string, number> {
  const map = new Map<string, number>();
  for (const ev of sourceEvents) {
    const date = localDateString(new Date(ev.startUtc), timezone);
    const minutes =
      (new Date(ev.endUtc).getTime() - new Date(ev.startUtc).getTime()) / 60_000;
    map.set(date, (map.get(date) ?? 0) + minutes);
  }
  return map;
}

/**
 *   effectivePreferred(day) = max(floor, preferred - classMinutes*(reducedPerHour/60))
 *   effectiveMax(day)       = max(floor, max - classMinutes*(reducedPerHour/60))
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

export function effectiveMaxMinutes(classMinutesOnDay: number, config: Config): number {
  const { maxDailyMinutes, classLoadAdjustment } = config.workload;
  if (!classLoadAdjustment.enabled) return maxDailyMinutes;
  const reduction = classMinutesOnDay * (classLoadAdjustment.minutesReducedPerClassHour / 60);
  return Math.max(classLoadAdjustment.floorMinutes, maxDailyMinutes - reduction);
}
