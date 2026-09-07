import type { RawAssessment } from "./loadSchedule.js";
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
    startTime: a.startTime,
    endTime: a.endTime,
    title: a.title,
  }));
}

/**
 * Computes hard blackout windows for protected assessment types. Per spec,
 * exam protection scope is "all-subjects": the blackout blocks scheduling
 * of study sessions for *every* subject, not just the one being examined,
 * so the window before an exam is kept clear for focused final review.
 *
 * Window: [assessmentDate - blackoutDays, assessment end] in local
 * (Europe/Paris) time. If the assessment has no explicit time, the whole
 * assessment day is protected.
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
    if (a.endTime) {
      const { h, m } = parseHHmm(a.endTime);
      const [y, mo, d] = a.date.split("-").map(Number);
      endUtc = zonedTimeToUtc(y!, mo!, d!, h, m, 0, ASSESSMENT_TIMEZONE);
    } else {
      // Whole day protected: blackout runs through end of the assessment day.
      const nextDay = addDaysToDateString(a.date, 1);
      endUtc = localMidnightUtc(nextDay, ASSESSMENT_TIMEZONE);
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
