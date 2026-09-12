import type { RawAssessment, RawHoliday } from "./loadSchedule.js";
import type { Assessment, BlockedPeriod, Config } from "../types.js";
import { localMidnightUtc, addDaysToDateString, parseHHmm, zonedTimeToUtc } from "../util/timezone.js";

/** Assessment dates without an explicit timezone are interpreted as Europe/Paris (per spec). */
const ASSESSMENT_TIMEZONE = "Europe/Paris";

export function toDomainAssessments(raw: RawAssessment[]): Assessment[] {
    return raw.map((a) => ({
        id: a.id,
        subject: a.subject,
        type: a.type,
        date: a.date,
        endDate: a.endDate ?? a.date,
        startTime: a.startTime,
        endTime: a.endTime,
        title: a.title,
    }));
}

/**
 * Computes hard blackout windows for protected assessment types. Scope is
 * "all-subjects": blocks scheduling of study sessions for every subject,
 * not just the one being examined.
 *
 * Window: [date - blackoutDays, protected-end] in local (Europe/Paris)
 * time. A single-day exam with an explicit end time is protected through
 * that exact moment; anything else (multi-day exams, or no time given) is
 * protected through the end of the *last* exam day -- partiels are
 * typically a whole week, not a single date.
 */
export function computeExamBlackouts(
    assessments: Assessment[],
    config: Config
): (BlockedPeriod & { assessmentId: string })[] {
    const protectedTypes = new Set(config.assessments.protectedTypes);
    const blackoutDays = config.examProtection.blackoutDays;

    const result: (BlockedPeriod & { assessmentId: string })[] = [];

    for (const a of assessments) {
        if (!protectedTypes.has(a.type)) continue;

        const windowStartDate = addDaysToDateString(a.date, -blackoutDays);
        const startUtc = localMidnightUtc(windowStartDate, ASSESSMENT_TIMEZONE);

        let endUtc: Date;
        if (a.endTime && a.endDate === a.date) {
            const { h, m } = parseHHmm(a.endTime);
            const [y, mo, d] = a.date.split("-").map(Number);
            endUtc = zonedTimeToUtc(y!, mo!, d!, h, m, 0, ASSESSMENT_TIMEZONE);
        } else {
            const dayAfterEnd = addDaysToDateString(a.endDate, 1);
            endUtc = localMidnightUtc(dayAfterEnd, ASSESSMENT_TIMEZONE);
        }

        result.push({
            id: `blackout-${a.id}`,
            assessmentId: a.id,
            startUtc: startUtc.toISOString(),
            endUtc: endUtc.toISOString(),
            reason: `Exam protection: ${a.title}`,
        });
    }

    return result;
}

function parseFloatingLocalDateTime(s: string): {
    y: number; mo: number; d: number; h: number; mi: number; se: number;
} {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(s);
    if (!m) {
        throw new Error(`Invalid holiday datetime "${s}", expected "YYYY-MM-DDTHH:mm:ss"`);
    }
    return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), h: Number(m[4]), mi: Number(m[5]), se: Number(m[6]) };
}

/**
 * Converts schedule.js's HOLIDAYS_SCHEDULE into hard BlockedPeriods -- no
 * classes/study/basketball scheduled during a break. Datetimes are
 * floating, interpreted as Europe/Paris (same convention as exam dates).
 */
export function computeHolidayPeriods(holidays: RawHoliday[]): BlockedPeriod[] {
    return holidays.map((h, idx) => {
        const s = parseFloatingLocalDateTime(h.startDate);
        const e = parseFloatingLocalDateTime(h.endDate);
        const startUtc = zonedTimeToUtc(s.y, s.mo, s.d, s.h, s.mi, s.se, ASSESSMENT_TIMEZONE).toISOString();
        const endUtc = zonedTimeToUtc(e.y, e.mo, e.d, e.h, e.mi, e.se, ASSESSMENT_TIMEZONE).toISOString();
        return {
            id: `holiday-${idx}`,
            startUtc,
            endUtc,
            reason: `Holiday: ${h.name}`,
        };
    });
}