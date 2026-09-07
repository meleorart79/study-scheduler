import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { z } from "zod";

export class AssessmentLoadError extends Error {}

const assessmentRawSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  type: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
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
});

const scheduleModuleSchema = z.object({
  EXAM_SCHEDULE: z.array(assessmentRawSchema),
  SEMESTER_START: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type RawAssessment = z.infer<typeof assessmentRawSchema>;

export interface LoadedSchedule {
  examSchedule: RawAssessment[];
  semesterStart: string;
}

/**
 * Loads schedule.js as CommonJS regardless of the surrounding project's
 * package.json "type" field. We deliberately don't go through Node's
 * normal require()/import() resolution (which would treat a plain .js
 * file as ESM under a "type": "module" package and choke on
 * `module.exports`); instead we read the source and evaluate it in a
 * CommonJS-shaped wrapper, exactly like Node's own module loader does
 * internally.
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

  // Duplicate id detection: fail loudly rather than silently dropping one.
  const seen = new Set<string>();
  for (const a of parsed.data.EXAM_SCHEDULE) {
    if (seen.has(a.id)) {
      throw new AssessmentLoadError(`schedule.js has a duplicate assessment id: "${a.id}"`);
    }
    seen.add(a.id);
  }

  return {
    examSchedule: parsed.data.EXAM_SCHEDULE,
    semesterStart: parsed.data.SEMESTER_START,
  };
}
