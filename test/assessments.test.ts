import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadScheduleFile, AssessmentLoadError } from "../src/assessments/loadSchedule.js";
import { computeExamBlackouts, toDomainAssessments } from "../src/assessments/blackout.js";
import { configSchema } from "../src/config/schema.js";
import { parse as parseYaml } from "yaml";
import { readFileSync } from "node:fs";

const dirs: string[] = [];
function tmpFile(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sched-test-"));
  dirs.push(dir);
  const file = path.join(dir, "schedule.js");
  writeFileSync(file, contents, "utf8");
  return file;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function baseConfig() {
  const raw = parseYaml(readFileSync(path.join(process.cwd(), "config/default.yaml"), "utf8"));
  return configSchema.parse(raw);
}

describe("schedule.js loading", () => {
  it("loads a well-formed CommonJS schedule.js regardless of package.json type:module", () => {
    const file = tmpFile(`
      const EXAM_SCHEDULE = [
        { id: "e1", subject: "Algo", type: "partiel", date: "2026-10-12", startTime: "09:00", endTime: "11:00", title: "Algo Partiel" }
      ];
      const SEMESTER_START = "2026-09-01";
      module.exports = { EXAM_SCHEDULE, SEMESTER_START };
    `);
    const result = loadScheduleFile(file);
    expect(result.examSchedule).toHaveLength(1);
    expect(result.semesterStart).toBe("2026-09-01");
  });

  it("rejects a schedule.js with an invalid shape", () => {
    const file = tmpFile(`module.exports = { EXAM_SCHEDULE: "not-an-array", SEMESTER_START: "2026-09-01" };`);
    expect(() => loadScheduleFile(file)).toThrow(AssessmentLoadError);
  });

  it("rejects duplicate assessment ids", () => {
    const file = tmpFile(`
      const EXAM_SCHEDULE = [
        { id: "dup", subject: "A", type: "partiel", date: "2026-10-01", startTime: null, endTime: null, title: "A" },
        { id: "dup", subject: "B", type: "partiel", date: "2026-10-02", startTime: null, endTime: null, title: "B" }
      ];
      module.exports = { EXAM_SCHEDULE, SEMESTER_START: "2026-09-01" };
    `);
    expect(() => loadScheduleFile(file)).toThrow(/duplicate assessment id/);
  });

  it("surfaces a syntax error as an AssessmentLoadError, not a crash", () => {
    const file = tmpFile(`this is not valid javascript {{{`);
    expect(() => loadScheduleFile(file)).toThrow(AssessmentLoadError);
  });
});

describe("exam blackout computation", () => {
  it("only protects configured protectedTypes", () => {
    const config = baseConfig(); // protectedTypes: ["partiel"]
    const assessments = toDomainAssessments([
      { id: "quiz1", subject: "DB", type: "quiz", date: "2026-10-12", startTime: null, endTime: null, title: "Quiz" },
      { id: "partiel1", subject: "Algo", type: "partiel", date: "2026-10-12", startTime: "09:00", endTime: "11:00", title: "Partiel" },
    ]);
    const blackouts = computeExamBlackouts(assessments, config);
    expect(blackouts).toHaveLength(1);
    expect(blackouts[0]!.assessmentId).toBe("partiel1");
  });

  it("blackout window spans blackoutDays before the exam through its end time", () => {
    const config = baseConfig();
    config.examProtection.blackoutDays = 7;
    const assessments = toDomainAssessments([
      { id: "p1", subject: "Algo", type: "partiel", date: "2026-10-12", startTime: "09:00", endTime: "11:00", title: "Partiel" },
    ]);
    const [blackout] = computeExamBlackouts(assessments, config);
    // 2026-10-12 minus 7 days = 2026-10-05, midnight Europe/Paris (CEST, UTC+2)
    expect(blackout!.startUtc).toBe("2026-10-04T22:00:00.000Z");
    expect(blackout!.endUtc).toBe("2026-10-12T09:00:00.000Z");
  });

  it("protects the whole day when no exam time is given", () => {
    const config = baseConfig();
    config.examProtection.blackoutDays = 0;
    const assessments = toDomainAssessments([
      { id: "p1", subject: "Networks", type: "partiel", date: "2026-11-03", startTime: null, endTime: null, title: "All-day" },
    ]);
    const [blackout] = computeExamBlackouts(assessments, config);
    // Europe/Paris is UTC+1 in November (CET), so local midnight is 23:00Z the day before.
    expect(blackout!.startUtc).toBe("2026-11-02T23:00:00.000Z");
    expect(blackout!.endUtc).toBe("2026-11-03T23:00:00.000Z");
  });
});
