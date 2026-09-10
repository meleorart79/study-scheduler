import { describe, it, expect } from "vitest";
import { generateStudyIcs, generateSchoolIcs } from "../src/ics-output/generate.js";
import { baseConfig, makeSourceEvent } from "./helpers.js";
import type { StudySession } from "../src/types.js";

function session(overrides: Partial<StudySession> = {}): StudySession {
  return {
    id: "study-abc-near",
    sourceCanonicalId: "abc",
    sourceSummary: "Algorithms Lecture",
    reviewName: "near",
    status: "SCHEDULED",
    startUtc: "2026-09-09T10:00:00.000Z",
    endUtc: "2026-09-09T11:30:00.000Z",
    orphaned: false,
    hasManualOverride: false,
    needsAttentionReason: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const config = baseConfig();

describe("ICS output", () => {
  it("produces a standards-shaped VCALENDAR/VEVENT with required properties", () => {
    const ics = generateStudyIcs([session()], config, { domain: "example.test" });
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("UID:study-abc-near@example.test");
    expect(ics).toContain("SUMMARY:Review 1 — Algorithms Lecture");
    expect(ics).toContain("DTSTART");
    expect(ics).toContain("DTEND");
    expect(ics).toContain("END:VEVENT");
    expect(ics).toContain("END:VCALENDAR");
  });

  it("includes VTIMEZONE information for Europe/Paris", () => {
    const ics = generateStudyIcs([session()], config, { domain: "example.test" });
    expect(ics).toContain("BEGIN:VTIMEZONE");
    expect(ics).toContain("TZID:Europe/Paris");
    expect(ics).toContain("END:VTIMEZONE");
  });

  it("omits SKIPPED, CANCELLED, and NEEDS_ATTENTION sessions", () => {
    const sessions = [
      session({ id: "s-skip", status: "SKIPPED", startUtc: null, endUtc: null }),
      session({ id: "s-cancel", status: "CANCELLED", startUtc: null, endUtc: null }),
      session({ id: "s-na", status: "NEEDS_ATTENTION", startUtc: null, endUtc: null }),
      session({ id: "s-ok", status: "SCHEDULED" }),
    ];
    const ics = generateStudyIcs(sessions, config, { domain: "example.test" });
    expect(ics).toContain("s-ok@example.test");
    expect(ics).not.toContain("s-skip@example.test");
    expect(ics).not.toContain("s-cancel@example.test");
    expect(ics).not.toContain("s-na@example.test");
  });

  it("includes LOCKED sessions (with a placement) in the output", () => {
    const ics = generateStudyIcs([session({ status: "LOCKED" })], config, { domain: "example.test" });
    expect(ics).toContain("study-abc-near@example.test");
  });

  it("numbers reviews chronologically per source class, not stored, recomputed at render time", () => {
    const near = session({
      id: "study-abc-near",
      reviewName: "near",
      startUtc: "2026-09-16T10:00:00.000Z",
      endUtc: "2026-09-16T11:30:00.000Z",
    });
    const far = session({
      id: "study-abc-far",
      reviewName: "far",
      startUtc: "2026-09-09T10:00:00.000Z", // earlier in time than "near" here
      endUtc: "2026-09-09T11:30:00.000Z",
    });
    const ics = generateStudyIcs([near, far], config, { domain: "example.test" });
    // far session, despite being named "far", is chronologically first -> "Review 1"
    const events = ics.split("BEGIN:VEVENT").slice(1);
    const farBlock = events.find((e) => e.includes("study-abc-far@example.test"))!;
    const nearBlock = events.find((e) => e.includes("study-abc-near@example.test"))!;
    expect(farBlock).toContain("Review 1");
    expect(nearBlock).toContain("Review 2");
  });

  it("uses stable UIDs of the form study-{canonicalId}-{reviewName}@domain", () => {
    const ics = generateStudyIcs([session({ id: "study-xyz123-far", reviewName: "far" })], config, {
      domain: "my-host.example",
    });
    expect(ics).toContain("UID:study-xyz123-far@my-host.example");
  });

  it("produces valid CRLF line endings per RFC 5545", () => {
    const ics = generateStudyIcs([session()], config, { domain: "example.test" });
    expect(ics.includes("\r\n")).toBe(true);
  });
});

describe("school ICS output (pure timetable pass-through)", () => {
  it("produces a standards-shaped VCALENDAR containing the source events, no study sessions", () => {
    const events = [
      makeSourceEvent({ canonicalId: "algo-1", summary: "Algorithms Lecture" }),
      makeSourceEvent({ canonicalId: "db-1", summary: "Databases TD" }),
    ];
    const ics = generateSchoolIcs(events, config, { domain: "example.test" });
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("UID:school-algo-1@example.test");
    expect(ics).toContain("UID:school-db-1@example.test");
    expect(ics).toContain("SUMMARY:Algorithms Lecture");
    expect(ics).toContain("SUMMARY:Databases TD");
    expect(ics).not.toContain("Review 1");
    expect(ics).not.toContain("UID:study-");
    expect(ics).toContain("END:VCALENDAR");
  });

  it("is independent of the study feed's UID namespace (school-/study- never collide)", () => {
    const ics = generateSchoolIcs([makeSourceEvent({ canonicalId: "abc" })], config, {
      domain: "example.test",
    });
    expect(ics).toContain("UID:school-abc@example.test");
    expect(ics).not.toContain("UID:study-abc");
  });
});
