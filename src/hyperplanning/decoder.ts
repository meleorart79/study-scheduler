import type { RawNormalizedEvent } from "../ics-input/types.js";
import { addDaysToDateString, zonedTimeToUtc } from "../util/timezone.js";
import type {
  DecodedHyperplanning,
  HyperplanningCourse,
  HyperplanningCourseMeta,
  HyperplanningDecoderOptions,
  HyperplanningScheduleData,
} from "./types.js";

const DEFAULT_PLACES_PER_DAY = 56;
const SLOT_MINUTES = 15;
const GRID_START_MINUTES = 8 * 60;

export class HyperplanningDecodeError extends Error {}

export function parseCompactIntList(value: string): number[] {
  const text = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!text) return [];
  const out: number[] = [];
  for (const token of text.split(",")) {
    const part = token.trim();
    if (!part) continue;
    const range = /^(\d+)\.\.(\d+)$/.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (end < start) throw new HyperplanningDecodeError(`Invalid compact range: ${part}`);
      for (let n = start; n <= end; n++) out.push(n);
    } else if (/^\d+$/.test(part)) {
      out.push(Number(part));
    } else {
      throw new HyperplanningDecodeError(`Invalid compact integer list token: ${part}`);
    }
  }
  return [...new Set(out)];
}

export function decodePeriodPosition(
  p: number,
  d: number,
  placesPerDay = DEFAULT_PLACES_PER_DAY,
): { dayIndex: number; startMinutes: number; endMinutes: number } {
  if (!Number.isInteger(p) || p < 0) throw new HyperplanningDecodeError(`Invalid course position p=${p}`);
  if (!Number.isInteger(d) || d <= 0) throw new HyperplanningDecodeError(`Invalid course duration d=${d}`);
  if (!Number.isInteger(placesPerDay) || placesPerDay <= 0) {
    throw new HyperplanningDecodeError(`Invalid placesPerDay=${placesPerDay}`);
  }

  const dayIndex = Math.floor(p / placesPerDay);
  const slotIndex = p % placesPerDay;
  const startMinutes = GRID_START_MINUTES + slotIndex * SLOT_MINUTES;
  const endMinutes = startMinutes + d * SLOT_MINUTES;

  if (dayIndex > 6 || endMinutes > 24 * 60) {
    throw new HyperplanningDecodeError(
      `Course position outside Monday-Sunday 08:00-24:00 grid: p=${p}, d=${d}, placesPerDay=${placesPerDay}`
    );
  }
  return { dayIndex, startMinutes, endMinutes };
}

function fieldLabel(entry: { G: number; C?: unknown } | undefined): string | null {
  if (!entry) return null;
  const c = entry.C;
  if (Array.isArray(c)) {
    const labels = c
      .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
      .map(v => typeof v.L === "string" ? v.L : null)
      .filter((v): v is string => !!v);
    return labels.length ? labels.join(" / ") : null;
  }
  if (typeof c === "object" && c !== null && typeof (c as Record<string, unknown>).L === "string") {
    return (c as Record<string, string>).L;
  }
  return null;
}

function meta(course: HyperplanningCourse): HyperplanningCourseMeta {
  const entries = course.listeC ?? [];
  const byG = (g: number) => entries.find(x => x.G === g);
  return {
    subject: fieldLabel(byG(0)),
    teacher: fieldLabel(byG(1)),
    room: fieldLabel(byG(3)),
    type: fieldLabel(byG(7)),
    group: fieldLabel(byG(14)),
  };
}

function minutesToParts(total: number): { hour: number; minute: number } {
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

export function decodeHyperplanningSchedule(
  data: HyperplanningScheduleData,
  options: HyperplanningDecoderOptions,
): DecodedHyperplanning {
  if (!data || !Array.isArray(data.ListeCours)) {
    throw new HyperplanningDecodeError("FonctionEmploiDuTemps response has no ListeCours array");
  }

  const events: RawNormalizedEvent[] = [];
  const placesPerDay = options.placesPerDay ?? DEFAULT_PLACES_PER_DAY;

  for (const course of data.ListeCours) {
    if (!course || typeof course.N !== "string") throw new HyperplanningDecodeError("Course is missing its stable N identifier");
    if (typeof course.p !== "number" || typeof course.d !== "number") {
      throw new HyperplanningDecodeError(`Course ${course.N} is missing numeric p/d`);
    }
    if (course.nbE === 0) continue;

    const weeks = course.dom ? parseCompactIntList(course.dom) : [];
    if (!weeks.length) throw new HyperplanningDecodeError(`Course ${course.N} has no dom week set`);

    const position = decodePeriodPosition(course.p, course.d, placesPerDay);
    const m = meta(course);
    if (!m.subject) throw new HyperplanningDecodeError(`Course ${course.N} has no subject label`);

    const { hour: startHour, minute: startMinute } = minutesToParts(position.startMinutes);
    const { hour: endHour, minute: endMinute } = minutesToParts(position.endMinutes);

    for (const week of weeks) {
      if (week < 1) throw new HyperplanningDecodeError(`Course ${course.N} contains invalid week ${week}`);
      const date = addDaysToDateString(options.academicWeek1Monday, (week - 1) * 7 + position.dayIndex);
      const start = zonedTimeToUtc(
        Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)),
        startHour, startMinute, 0, options.timezone,
      );
      const end = zonedTimeToUtc(
        Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)),
        endHour, endMinute, 0, options.timezone,
      );
      if (end <= start) throw new HyperplanningDecodeError(`Decoded event has end <= start for ${course.N}`);

      events.push({
        uid: `hyperplanning:${course.N}:${date}:${position.startMinutes}`,
        recurrenceKey: date,
        summary: m.type ? `${m.subject} (${m.type})` : m.subject,
        startUtc: start,
        endUtc: end,
        sourceTimezone: options.timezone,
        wasFloating: false,
        location: m.room,
      });
    }
  }

  return {
    events: events.sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime()),
    courseCount: data.ListeCours.length,
    expandedOccurrenceCount: events.length,
  };
}
