import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../src/state/db.js";
import { Repository } from "../src/state/repository.js";
import { ConfigHolder } from "../src/config/holder.js";
import { regenerate, ConcurrentRegenerationError } from "../src/pipeline.js";
import { logger } from "../src/logging/logger.js";
import { baseConfig } from "./helpers.js";

const SAMPLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:pipeline-test-1@example.com
SUMMARY:Algorithms Lecture
DTSTART;TZID=Europe/Paris:20260908T090000
DTEND;TZID=Europe/Paris:20260908T110000
END:VEVENT
END:VCALENDAR`;

let server: http.Server;
let port: number;
let requestCount = 0;
let failMode = false;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requestCount++;
    if (failMode) {
      res.writeHead(500);
      res.end("boom");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/calendar" });
    res.end(SAMPLE_ICS);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as any).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function setupTestEnv() {
  const dir = mkdtempSync(path.join(tmpdir(), "pipeline-test-"));
  const schedulePath = path.join(dir, "schedule.js");
  writeFileSync(
    schedulePath,
    `module.exports = { EXAM_SCHEDULE: [], SEMESTER_START: "2026-09-01" };`
  );
  const db = openDatabase(":memory:");
  const repo = new Repository(db);
  const config = baseConfig((c) => {
    c.sourceFeed.url = `http://127.0.0.1:${port}/feed.ics`;
    c.assessments.file = schedulePath;
  });
  const configHolder = new ConfigHolder(config, repo);
  return { dir, db, repo, configHolder };
}

beforeEach(() => {
  requestCount = 0;
  failMode = false;
});

describe("pipeline: regenerate", () => {
  it("runs the full pipeline successfully and caches an ICS output", async () => {
    const { repo, configHolder, dir } = setupTestEnv();
    const run = await regenerate({ repo, configHolder, domain: "test.local", logger }, "startup");
    expect(run.status).toBe("SUCCESS");
    expect(repo.getKv("last_good_ics")).toContain("BEGIN:VCALENDAR");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns NO_OP on a subsequent cron run when nothing changed, without re-fetching effort duplicated", async () => {
    const { repo, configHolder, dir } = setupTestEnv();
    const run1 = await regenerate({ repo, configHolder, domain: "test.local", logger }, "startup");
    expect(run1.status).toBe("SUCCESS");
    const run2 = await regenerate({ repo, configHolder, domain: "test.local", logger }, "cron");
    expect(run2.status).toBe("NO_OP");
    rmSync(dir, { recursive: true, force: true });
  });

  it("manual regeneration always runs fully even if nothing changed", async () => {
    const { repo, configHolder, dir } = setupTestEnv();
    await regenerate({ repo, configHolder, domain: "test.local", logger }, "startup");
    const run2 = await regenerate({ repo, configHolder, domain: "test.local", logger }, "manual");
    expect(run2.status).toBe("SUCCESS");
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a concurrent regeneration with ConcurrentRegenerationError", async () => {
    const { repo, configHolder, dir } = setupTestEnv();
    const p1 = regenerate({ repo, configHolder, domain: "test.local", logger }, "manual");
    await expect(
      regenerate({ repo, configHolder, domain: "test.local", logger }, "manual")
    ).rejects.toThrow(ConcurrentRegenerationError);
    await p1;
    rmSync(dir, { recursive: true, force: true });
  });

  it("aborts before mutating state on feed failure and keeps serving the last known-good output", async () => {
    const { repo, configHolder, dir } = setupTestEnv();
    const good = await regenerate({ repo, configHolder, domain: "test.local", logger }, "startup");
    expect(good.status).toBe("SUCCESS");
    const goodIcs = repo.getKv("last_good_ics");
    const goodSessions = repo.getAllStudySessions();

    failMode = true;
    const failed = await regenerate({ repo, configHolder, domain: "test.local", logger }, "manual");
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toBeTruthy();

    expect(repo.getKv("last_good_ics")).toBe(goodIcs);
    expect(repo.getAllStudySessions()).toEqual(goodSessions);
    rmSync(dir, { recursive: true, force: true });
  });
});
