import { createHash } from "node:crypto";
import type { BlockedPeriod, Config } from "../types.js";
import { addDaysToDateString, parseHHmm, utcToZonedParts, zonedTimeToUtc } from "../util/timezone.js";

const WEEKDAY_INDEX: Record<string, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

function weekdayIndexForDate(dateStr: string, timezone: string): number {
    const [y, m, d] = dateStr.split("-").map(Number);
    const noonUtc = zonedTimeToUtc(y!, m!, d!, 12, 0, 0, timezone);
    return utcToZonedParts(noonUtc, timezone).weekday;
}

function makeId(startUtc: string, endUtc: string, reason: string): string {
    return `cfg-${createHash("sha1").update(`${startUtc}|${endUtc}|${reason}`).digest("hex").slice(0, 12)}`;
}

interface SuppressionWindow {
    startUtc: string;
    endUtc: string;
}

function overlapsAnyWindow(startUtc: string, endUtc: string, windows: SuppressionWindow[]): boolean {
    const s = new Date(startUtc).getTime();
    const e = new Date(endUtc).getTime();
    return windows.some((w) => s < new Date(w.endUtc).getTime() && new Date(w.startUtc).getTime() < e);
}

interface ExpandedRecurringPeriod extends BlockedPeriod {
    visible: boolean;
}

/**
 * Expands config.recurringBlockedPeriods into concrete instants across
 * [rangeStartDate, rangeEndDate]. Occurrences overlapping any
 * suppressionWindows entry (exam blackouts, holidays) are skipped entirely
 * — e.g. no basketball during exam-prep/exam week or a break.
 */
function expandRecurringBlockedPeriods(
    config: Config,
    rangeStartDate: string,
    rangeEndDate: string,
    suppressionWindows: SuppressionWindow[]
): ExpandedRecurringPeriod[] {
    const rules = config.recurringBlockedPeriods;
    if (!rules || rules.length === 0) return [];

    const out: ExpandedRecurringPeriod[] = [];
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
            if (overlapsAnyWindow(startUtc, endUtc, suppressionWindows)) continue;
            out.push({
                id: makeId(startUtc, endUtc, rule.reason),
                startUtc,
                endUtc,
                reason: rule.reason,
                visible: rule.visible ?? true,
            });
        }
        cur = addDaysToDateString(cur, 1);
    }
    return out;
}

/** Hard blocks for the scheduling engine (visible or not — all of them block time). */
export function blockedPeriodsFromConfig(
    config: Config,
    rangeStartDate: string,
    rangeEndDate: string,
    suppressionWindows: SuppressionWindow[] = []
): BlockedPeriod[] {
    const staticPeriods = config.blockedPeriods.map((bp) => ({
        id: makeId(bp.startUtc, bp.endUtc, bp.reason),
        startUtc: bp.startUtc,
        endUtc: bp.endUtc,
        reason: bp.reason,
    }));
    const recurring = expandRecurringBlockedPeriods(config, rangeStartDate, rangeEndDate, suppressionWindows);
    return [...staticPeriods, ...recurring.map(({ visible, ...bp }) => bp)];
}

export function blockedPeriodsFromConfig(
    config: Config,
    rangeStartDate: string,
    rangeEndDate: string,
    suppressionWindows: SuppressionWindow[] = []
): BlockedPeriod[] {
    const staticPeriods = config.blockedPeriods.map((bp) => ({
        id: makeId(bp.startUtc, bp.endUtc, bp.reason),
        startUtc: bp.startUtc,
        endUtc: bp.endUtc,
        reason: bp.reason,
    }));
    const recurring = expandRecurringBlockedPeriods(config, rangeStartDate, rangeEndDate, suppressionWindows);
    return [...staticPeriods, ...recurring.map(({ visible, ...bp }) => bp)];
}

/**
 * Everything that should render as a real event in study.ics: static
 * blockedPeriods marked visible, plus recurring commitments (e.g.
 * basketball) marked visible, minus anything suppressed by
 * suppressionWindows (exam blackouts, holidays).
 */
export function visibleCommitmentPeriods(
    config: Config,
    rangeStartDate: string,
    rangeEndDate: string,
    suppressionWindows: SuppressionWindow[] = []
): BlockedPeriod[] {
    const visibleStatic = config.blockedPeriods
        .filter((bp) => bp.visible ?? true)
        .filter((bp) => !overlapsAnyWindow(bp.startUtc, bp.endUtc, suppressionWindows))
        .map((bp) => ({
            id: makeId(bp.startUtc, bp.endUtc, bp.reason),
            startUtc: bp.startUtc,
            endUtc: bp.endUtc,
            reason: bp.reason,
        }));

    const visibleRecurring = expandRecurringBlockedPeriods(config, rangeStartDate, rangeEndDate, suppressionWindows)
        .filter((p) => p.visible)
        .map(({ visible, ...bp }) => bp);

    return [...visibleStatic, ...visibleRecurring];
}