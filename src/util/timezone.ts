/**
 * Minimal IANA-timezone-aware date utilities built on Intl, so we don't
 * need luxon/moment-timezone as a dependency. All "local" here means
 * "wall-clock time in the given IANA timezone".
 */

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday .. 6 = Saturday
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Decompose a UTC instant into local wall-clock parts for a given IANA zone. */
export function utcToZonedParts(utcDate: Date, timeZone: string): LocalParts {
  const parts = getFormatter(timeZone).formatToParts(utcDate);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hourStr = get("hour");
  // Intl with hour12:false can emit "24" for midnight in some locales/environments; normalize.
  let hour = parseInt(hourStr, 10);
  if (hour === 24) hour = 0;
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    hour,
    minute: parseInt(get("minute"), 10),
    second: parseInt(get("second"), 10),
    weekday: WEEKDAY_MAP[get("weekday")] ?? new Date(utcDate).getUTCDay(),
  };
}

/**
 * Convert local wall-clock components in an IANA zone to a UTC Date.
 * Uses the standard "guess and correct" algorithm so it's correct across
 * DST transitions. For the rare spring-forward gap (nonexistent local time)
 * this returns the instant as if the offset were the pre-transition offset;
 * for the fall-back overlap (ambiguous local time) it returns the first
 * (earlier, pre-transition) matching instant.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): Date {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = asIfUtc;

  for (let i = 0; i < 3; i++) {
    const parts = utcToZonedParts(new Date(guess), timeZone);
    const guessedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    const diff = guessedAsUtc - asIfUtc;
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}

export function localDateString(utcDate: Date, timeZone: string): string {
  const p = utcToZonedParts(utcDate, timeZone);
  return `${pad4(p.year)}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function localTimeString(utcDate: Date, timeZone: string): string {
  const p = utcToZonedParts(utcDate, timeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

export function isWeekend(utcDate: Date, timeZone: string): boolean {
  const wd = utcToZonedParts(utcDate, timeZone).weekday;
  return wd === 0 || wd === 6;
}

export function localMidnightUtc(dateStr: string, timeZone: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return zonedTimeToUtc(y!, m!, d!, 0, 0, 0, timeZone);
}

export function addDaysToDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  // Use noon UTC as a pivot to avoid any DST edge weirdness in plain date math.
  const pivot = new Date(Date.UTC(y!, m! - 1, d!, 12, 0, 0));
  pivot.setUTCDate(pivot.getUTCDate() + days);
  return `${pad4(pivot.getUTCFullYear())}-${pad2(pivot.getUTCMonth() + 1)}-${pad2(
    pivot.getUTCDate()
  )}`;
}

export function parseHHmm(t: string): { h: number; m: number } {
  const [h, m] = t.split(":").map(Number);
  return { h: h!, m: m! };
}

export function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
export function pad4(n: number): string {
  return n.toString().padStart(4, "0");
}

/** Minutes since local midnight for a UTC instant in the given zone. */
export function minutesOfDay(utcDate: Date, timeZone: string): number {
  const p = utcToZonedParts(utcDate, timeZone);
  return p.hour * 60 + p.minute;
}
