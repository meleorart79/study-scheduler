import { createHash } from "node:crypto";
import {
  unfold,
  extractVEventBlocks,
  parseVEventBlock,
  type ParsedVEvent,
  type TimeValue,
} from "./lowlevel.js";
import { parseRRule, expandRRuleDates } from "./rrule.js";
import { zonedTimeToUtc, localDateString } from "../util/timezone.js";
import type { ParseResult, ParseWarning, RawNormalizedEvent } from "./types.js";

export interface ParseOptions {
  rangeStartUtc: Date;
  rangeEndUtc: Date;
  /** IANA timezone used to interpret floating (no-TZID) local times. */
  fallbackTimezone: string;
}

/** Convert a TimeValue into a concrete UTC Date, per its own kind. */
function timeValueToUtc(
  tv: TimeValue,
  fallbackTimezone: string
): { utc: Date; wasFloating: boolean; tzUsed: string | null } {
  if (tv.kind === "utc") {
    return {
      utc: new Date(Date.UTC(tv.y, tv.m - 1, tv.d, tv.h, tv.mi, tv.s)),
      wasFloating: false,
      tzUsed: null,
    };
  }
  if (tv.kind === "zoned" && tv.tzid) {
    return {
      utc: zonedTimeToUtc(tv.y, tv.m, tv.d, tv.h, tv.mi, tv.s, tv.tzid),
      wasFloating: false,
      tzUsed: tv.tzid,
    };
  }
  // floating or date-only: interpret wall-clock time in fallback timezone.
  return {
    utc: zonedTimeToUtc(tv.y, tv.m, tv.d, tv.h, tv.mi, tv.s, fallbackTimezone),
    wasFloating: true,
    tzUsed: fallbackTimezone,
  };
}

function dateStringOf(tv: TimeValue): string {
  return `${String(tv.y).padStart(4, "0")}-${String(tv.m).padStart(2, "0")}-${String(
    tv.d
  ).padStart(2, "0")}`;
}

function fallbackUid(block: ParsedVEvent, index: number): string {
  const basis = `${block.summary}|${block.dtstart ? dateStringOf(block.dtstart) : ""}|${index}`;
  return `generated-${createHash("sha1").update(basis).digest("hex").slice(0, 16)}`;
}

export function parseIcsFeed(text: string, opts: ParseOptions): ParseResult {
  const warnings: ParseWarning[] = [];
  const lines = unfold(text);
  const rawBlocks = extractVEventBlocks(lines);
  const parsed = rawBlocks.map((b) => parseVEventBlock(b));

  // Assign fallback UIDs to any block missing one, and warn.
  parsed.forEach((p, idx) => {
    if (!p.uid) {
      p.uid = fallbackUid(p, idx);
      warnings.push({ uid: p.uid, message: "VEVENT missing UID; generated a synthetic one" });
    }
  });

  // Warn on duplicate (uid, recurrenceId) pairs among non-recurring/override entries.
  const seenKeys = new Set<string>();

  const rangeStartDate = localDateString(opts.rangeStartUtc, opts.fallbackTimezone);
  const rangeEndDate = localDateString(opts.rangeEndUtc, opts.fallbackTimezone);

  // Partition: masters (have RRULE, no RECURRENCE-ID), overrides (have RECURRENCE-ID),
  // and simple one-off events (neither).
  const masters = parsed.filter((p) => p.rruleRaw && !p.recurrenceId && !p.malformed);
  const overrides = parsed.filter((p) => p.recurrenceId && !p.malformed);
  const singles = parsed.filter((p) => !p.rruleRaw && !p.recurrenceId && !p.malformed);

  for (const p of parsed.filter((p) => p.malformed)) {
    warnings.push({
      uid: p.uid,
      message: `Skipping malformed VEVENT: ${p.malformedReason ?? "unknown reason"}`,
    });
  }

  const events: RawNormalizedEvent[] = [];

  // --- Simple one-off events ---
  for (const p of singles) {
    const key = `${p.uid}|`;
    if (seenKeys.has(key)) {
      warnings.push({ uid: p.uid, message: "Duplicate UID for non-recurring VEVENT; skipping repeat" });
      continue;
    }
    seenKeys.add(key);

    const startInfo = timeValueToUtc(p.dtstart!, opts.fallbackTimezone);
    const endUtc = computeEnd(p, startInfo.utc, opts.fallbackTimezone);
    if (endUtc <= startInfo.utc) {
      warnings.push({ uid: p.uid, message: "DTEND <= DTSTART; skipping" });
      continue;
    }
    if (startInfo.utc > opts.rangeEndUtc || endUtc < opts.rangeStartUtc) continue;

    events.push({
      uid: p.uid!,
      recurrenceKey: null,
      summary: p.summary,
      startUtc: startInfo.utc,
      endUtc,
      sourceTimezone: startInfo.tzUsed,
      wasFloating: startInfo.wasFloating,
      location: p.location,
    });
  }

  // --- Build override lookup: uid -> localDateKey(recurrenceId, master tz) -> override event ---
  const overrideByMasterUidAndDate = new Map<string, Map<string, ParsedVEvent>>();
  for (const o of overrides) {
    if (!o.uid) continue;
    const key = dateStringOf(o.recurrenceId!);
    if (!overrideByMasterUidAndDate.has(o.uid)) {
      overrideByMasterUidAndDate.set(o.uid, new Map());
    }
    overrideByMasterUidAndDate.get(o.uid)!.set(key, o);
  }

  // --- Recurring masters ---
  for (const master of masters) {
    if (!master.uid) continue;
    const spec = parseRRule(master.rruleRaw!);
    if (spec.freq === "UNSUPPORTED") {
      warnings.push({
        uid: master.uid,
        message: `Unsupported RRULE FREQ; treating as a single occurrence at DTSTART`,
      });
    }
    const dtstartTv = master.dtstart!;
    const dtstartDate = dateStringOf(dtstartTv);

    // Expand with generous lookback so occurrences before the horizon can still
    // satisfy EXDATE/override matching against correct series cadence; the date
    // filter for output happens per-occurrence below.
    const expandStart = dtstartDate < rangeStartDate ? dtstartDate : rangeStartDate;
    const occurrenceDates = expandRRuleDates(spec, dtstartDate, expandStart, rangeEndDate);

    const startInfoBase = timeValueToUtc(dtstartTv, opts.fallbackTimezone);
    const endBase = computeEnd(master, startInfoBase.utc, opts.fallbackTimezone);
    const durationMs = endBase.getTime() - startInfoBase.utc.getTime();
    if (durationMs <= 0) {
      warnings.push({ uid: master.uid, message: "Recurring event has non-positive duration; skipping series" });
      continue;
    }

    const exdateKeys = new Set(
      master.exdates.map((tv) => dateStringOf(tv))
    );
    const overrideMap = overrideByMasterUidAndDate.get(master.uid);

    for (const occDate of occurrenceDates) {
      if (exdateKeys.has(occDate)) continue;

      const override = overrideMap?.get(occDate);
      if (override) {
        const oKey = `${master.uid}|${occDate}`;
        if (seenKeys.has(oKey)) continue;
        seenKeys.add(oKey);

        const oStartInfo = timeValueToUtc(override.dtstart ?? dtstartTv, opts.fallbackTimezone);
        const oEnd = computeEnd(override, oStartInfo.utc, opts.fallbackTimezone);
        if (oEnd <= oStartInfo.utc) {
          warnings.push({ uid: master.uid, message: `Override for ${occDate} has DTEND<=DTSTART; skipping` });
          continue;
        }
        if (oStartInfo.utc > opts.rangeEndUtc || oEnd < opts.rangeStartUtc) continue;
        events.push({
          uid: master.uid,
          recurrenceKey: occDate,
          summary: override.summary,
          startUtc: oStartInfo.utc,
          endUtc: oEnd,
          sourceTimezone: oStartInfo.tzUsed,
          wasFloating: oStartInfo.wasFloating,
          location: override.location,
        });
        continue;
      }

      const [y, m, d] = occDate.split("-").map(Number);
      const occStartUtc =
        dtstartTv.kind === "utc"
          ? new Date(Date.UTC(y!, m! - 1, d!, dtstartTv.h, dtstartTv.mi, dtstartTv.s))
          : dtstartTv.kind === "zoned" && dtstartTv.tzid
          ? zonedTimeToUtc(y!, m!, d!, dtstartTv.h, dtstartTv.mi, dtstartTv.s, dtstartTv.tzid)
          : zonedTimeToUtc(y!, m!, d!, dtstartTv.h, dtstartTv.mi, dtstartTv.s, opts.fallbackTimezone);
      const occEndUtc = new Date(occStartUtc.getTime() + durationMs);

      if (occStartUtc > opts.rangeEndUtc || occEndUtc < opts.rangeStartUtc) continue;

      const key = `${master.uid}|${occDate}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      events.push({
        uid: master.uid,
        recurrenceKey: occDate,
        summary: master.summary,
        startUtc: occStartUtc,
        endUtc: occEndUtc,
        sourceTimezone: startInfoBase.tzUsed,
        wasFloating: startInfoBase.wasFloating,
        location: master.location,
      });
    }
  }

  events.sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime());
  return { events, warnings };
}

function computeEnd(p: ParsedVEvent, startUtc: Date, fallbackTimezone: string): Date {
  if (p.dtend) {
    return timeValueToUtc(p.dtend, fallbackTimezone).utc;
  }
  if (p.durationMinutes !== null) {
    return new Date(startUtc.getTime() + p.durationMinutes * 60_000);
  }
  // Shouldn't happen (caught by malformed check upstream), but be safe.
  return new Date(startUtc.getTime() + 60 * 60_000);
}
