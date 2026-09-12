import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { z } from "zod";

export class AssessmentLoadError extends Error {}

const assessmentRawSchema = z
  .object({
    id: z.string().min(1),
    subject: z.string().min(1),
    type: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
    /**
     * Optional end date for multi-day assessments (a week of partiels, not
     * a single date). Defaults to `date` when omitted. Must be >= date.
     */
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "endDate must be YYYY-MM-DD")
      .nullable()
      .optional(),
    startTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .optional()
      .default(null),
    endTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .optional()
      .default(null),
    title: z.string().min(1),
  })
  .refine((a) => !a.endDate || a.endDate >= a.date, {
    message: "endDate must be on or after date",
  });

const holidayRawSchema = z.object({
  name: z.string().min(1),
  /** Floating local datetime "YYYY-MM-DDTHH:mm:ss", interpreted as Europe/Paris. */
  startDate: z.string().min(1),
  endDate: z.string().min(1),
});

const scheduleModuleSchema = z.object({
  EXAM_SCHEDULE: z.array(assessmentRawSchema),
  SEMESTER_START: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  HOLIDAYS_SCHEDULE: z.array(holidayRawSchema).default([]),
});

export type RawAssessment = z.infer<typeof assessmentRawSchema>;
export type RawHoliday = z.infer<typeof holidayRawSchema>;

export interface LoadedSchedule {
  examSchedule: RawAssessment[];
  holidays: RawHoliday[];
  semesterStart: string;
}

/**
 * Loads schedule.js as CommonJS regardless of the surrounding project's
 * package.json "type" field. See original comment: we deliberately avoid
 * Node's normal require()/import() resolution and evaluate the source in a
 * CommonJS-shaped wrapper instead.
 */
export function loadScheduleFile(filePath: string): LoadedSchedule {
  const absPath = path.resolve(filePath);
  if (!existsSync(absPath)) {
    throw new AssessmentLoadError(`schedule file not found: ${absPath}`);
  }

  let code: string;
  try {
    code = readFileSync(absPath, "utf8");
  } catch (err) {
    throw new AssessmentLoadError(
      `Failed to read schedule file: ${(err as Error).message}`
    );
  }

  const wrapped = `(function(module, exports, require, __filename, __dirname) {\n${code}\n});`;

  let fn: Function;
  try {
    const script = new vm.Script(wrapped, { filename: absPath });
    fn = script.runInThisContext();
  } catch (err) {
    throw new AssessmentLoadError(
      `schedule.js failed to parse: ${(err as Error).message}`
    );
  }

  const mod = { exports: {} as Record<string, unknown> };
  const req = createRequire(absPath);

  try {
    fn(mod, mod.exports, req, absPath, path.dirname(absPath));
  } catch (err) {
    throw new AssessmentLoadError(
      `schedule.js threw while executing: ${(err as Error).message}`
    );
  }

  const parsed = scheduleModuleSchema.safeParse(mod.exports);
  if (!parsed.success) {
    throw new AssessmentLoadError(
      `schedule.js has an invalid shape:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`
    );
  }

  const seen = new Set<string>();
  for (const a of parsed.data.EXAM_SCHEDULE) {
    if (seen.has(a.id)) {
      throw new AssessmentLoadError(`schedule.js has a duplicate assessment id: "${a.id}"`);
    }
    seen.add(a.id);
  }

  return {
    examSchedule: parsed.data.EXAM_SCHEDULE,
    holidays: parsed.data.HOLIDAYS_SCHEDULE,
    semesterStart: parsed.data.SEMESTER_START,
  };
}