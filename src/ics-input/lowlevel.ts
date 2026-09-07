/**
 * Minimal RFC 5545 tokenizer. We deliberately avoid pulling in a full ICS
 * parsing library for the input side so that timezone/floating-time
 * handling is fully explicit and testable (see src/util/timezone.ts).
 */

export interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface TimeValue {
  kind: "utc" | "zoned" | "floating" | "date-only";
  tzid: string | null;
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export interface ParsedVEvent {
  uid: string | null;
  summary: string;
  location: string | null;
  dtstart: TimeValue | null;
  dtend: TimeValue | null;
  durationMinutes: number | null;
  rruleRaw: string | null;
  exdates: TimeValue[];
  recurrenceId: TimeValue | null;
  malformed: boolean;
  malformedReason: string | null;
}

/** Un-fold RFC 5545 continuation lines (lines starting with a space or tab). */
export function unfold(text: string): string[] {
  const rawLines = text.replace(/\r\n/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines;
}

/** Parse a single unfolded "NAME;PARAM=VAL;PARAM2=VAL2:VALUE" line. */
export function parseProperty(line: string): IcsProperty | null {
  const colonIdx = findUnquotedColon(line);
  if (colonIdx === -1) return null;
  const head = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const segments = head.split(";");
  const name = (segments[0] ?? "").toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]!;
    const eq = seg.indexOf("=");
    if (eq === -1) continue;
    const key = seg.slice(0, eq).toUpperCase();
    let val = seg.slice(eq + 1);
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { name, params, value };
}

function findUnquotedColon(line: string): number {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ":" && !inQuotes) return i;
  }
  return -1;
}

/** Split the full ICS text into raw VEVENT block line-arrays. */
export function extractVEventBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT$/i.test(line)) {
      current = [];
    } else if (/^END:VEVENT$/i.test(line)) {
      if (current) blocks.push(current);
      current = null;
    } else if (current) {
      current.push(line);
    }
  }
  return blocks;
}

function parseTimeValue(prop: IcsProperty): TimeValue | null {
  const value = prop.value.trim();
  const tzid = prop.params["TZID"] ?? null;
  const isDateOnly = prop.params["VALUE"] === "DATE" || /^\d{8}$/.test(value);

  if (isDateOnly) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    if (!m) return null;
    return {
      kind: "date-only",
      tzid: null,
      y: Number(m[1]),
      m: Number(m[2]),
      d: Number(m[3]),
      h: 0,
      mi: 0,
      s: 0,
    };
  }

  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!m) return null;
  const isUtc = Boolean(m[7]);
  return {
    kind: isUtc ? "utc" : tzid ? "zoned" : "floating",
    tzid: isUtc ? null : tzid,
    y: Number(m[1]),
    m: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4]),
    mi: Number(m[5]),
    s: Number(m[6]),
  };
}

function parseDurationMinutes(value: string): number | null {
  // ISO 8601 duration, subset commonly seen in ICS: PT#H#M#S, P#DT#H#M#S
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim()
  );
  if (!m) return null;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const minutes = Number(m[3] ?? 0);
  const seconds = Number(m[4] ?? 0);
  return days * 1440 + hours * 60 + minutes + Math.round(seconds / 60);
}

/** Unescape ICS TEXT value backslash-escapes (\\, \;, \,, \n). */
function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

export function parseVEventBlock(lines: string[]): ParsedVEvent {
  const result: ParsedVEvent = {
    uid: null,
    summary: "(untitled)",
    location: null,
    dtstart: null,
    dtend: null,
    durationMinutes: null,
    rruleRaw: null,
    exdates: [],
    recurrenceId: null,
    malformed: false,
    malformedReason: null,
  };

  for (const line of lines) {
    const prop = parseProperty(line);
    if (!prop) continue;
    switch (prop.name) {
      case "UID":
        result.uid = prop.value.trim();
        break;
      case "SUMMARY":
        result.summary = unescapeText(prop.value) || "(untitled)";
        break;
      case "LOCATION":
        result.location = unescapeText(prop.value) || null;
        break;
      case "DTSTART":
        result.dtstart = parseTimeValue(prop);
        break;
      case "DTEND":
        result.dtend = parseTimeValue(prop);
        break;
      case "DURATION":
        result.durationMinutes = parseDurationMinutes(prop.value);
        break;
      case "RRULE":
        result.rruleRaw = prop.value.trim();
        break;
      case "EXDATE": {
        for (const part of prop.value.split(",")) {
          const tv = parseTimeValue({ ...prop, value: part });
          if (tv) result.exdates.push(tv);
        }
        break;
      }
      case "RECURRENCE-ID":
        result.recurrenceId = parseTimeValue(prop);
        break;
      default:
        break;
    }
  }

  if (!result.dtstart) {
    result.malformed = true;
    result.malformedReason = "missing or unparseable DTSTART";
  }
  if (!result.dtend && result.durationMinutes === null && result.dtstart) {
    // No explicit end and no duration: RFC 5545 default is a zero-length
    // event for DATE-TIME starts. We treat that as malformed for our
    // purposes since a zero-length "class" can't sensibly block time.
    result.malformed = true;
    result.malformedReason = "missing DTEND and DURATION";
  }

  return result;
}
