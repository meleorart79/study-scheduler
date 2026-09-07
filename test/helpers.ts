import { parse as parseYaml } from "yaml";
import { readFileSync } from "node:fs";
import path from "node:path";
import { configSchema } from "../src/config/schema.js";
import type { Config, SourceEvent, StudySession, Override, Assessment } from "../src/types.js";

export function baseConfig(overrides?: (c: Config) => void): Config {
  const raw = parseYaml(readFileSync(path.join(process.cwd(), "config/default.yaml"), "utf8"));
  const config = configSchema.parse(raw) as Config;
  if (overrides) overrides(config);
  return config;
}

let counter = 0;
function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function makeSourceEvent(overrides: Partial<SourceEvent> = {}): SourceEvent {
  return {
    canonicalId: uniq("se"),
    rawUid: uniq("uid"),
    recurrenceKey: null,
    summary: "Algorithms Lecture",
    startUtc: "2026-09-08T07:00:00.000Z", // Tue 09:00 Europe/Paris (CEST)
    endUtc: "2026-09-08T09:00:00.000Z",
    sourceTimezone: "Europe/Paris",
    wasFloating: false,
    location: null,
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    lastSeenRunId: "run-0",
    ...overrides,
  };
}

export function makeAssessment(overrides: Partial<Assessment> = {}): Assessment {
  return {
    id: uniq("assessment"),
    subject: "Algorithms",
    type: "partiel",
    date: "2026-10-01",
    startTime: "09:00",
    endTime: "11:00",
    title: "Algorithms Partiel",
    ...overrides,
  };
}

export function makeOverride(overrides: Partial<Override> = {}): Override {
  return {
    id: uniq("override"),
    studySessionId: "study-x-near",
    action: "LOCK",
    newStartUtc: null,
    newEndUtc: null,
    createdAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

export function findSession(
  sessions: StudySession[],
  canonicalId: string,
  reviewName: string
): StudySession {
  const s = sessions.find((x) => x.sourceCanonicalId === canonicalId && x.reviewName === reviewName);
  if (!s) throw new Error(`session not found for ${canonicalId}/${reviewName}`);
  return s;
}
