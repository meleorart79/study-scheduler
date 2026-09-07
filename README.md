# study-scheduler

A single-user personal service that turns your university ICS timetable into
an automatically-scheduled calendar of spaced study/review sessions, served
as its own ICS subscription URL.

```
University ICS  →  scheduling engine  →  Study ICS (subscribe from your calendar app)
```

The university feed is read-only input. `schedule.js` is the sole source of
truth for exams/assessments. Everything else (study session placement,
locks, skips) is computed and persisted by this service.

---

## 1. Project structure

```
study-scheduler/
├── config/
│   └── default.yaml          # default configuration (day-specific study windows, etc.)
├── schedule.js                # YOUR exam/assessment schedule (edit this)
├── src/
│   ├── ics-input/              # fetch + parse + expand recurrence (RRULE/EXDATE/overrides)
│   ├── normalization/          # raw events -> stable SourceEvents (canonical IDs)
│   ├── assessments/            # loads schedule.js, computes exam blackout windows
│   ├── scheduling/             # the pure scheduling engine (no I/O)
│   ├── state/                  # SQLite persistence
│   ├── ics-output/              # generates the study.ics calendar
│   ├── http/                   # Fastify server (feed + admin API)
│   ├── cron/                   # daily 05:00 Europe/Paris regeneration job
│   ├── config/                  # zod schema, YAML loader, runtime config holder
│   ├── logging/                 # pino logger
│   ├── pipeline.ts              # the one regeneration flow used by startup/cron/manual
│   └── index.ts                 # entrypoint
├── test/                        # vitest unit/integration/property-based tests
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── package.json
```

The scheduling engine (`src/scheduling/engine.ts`) is a pure function:

```
(SourceEvents, Assessments, Config, Overrides, PrevState) -> NewState
```

It does not import from `http/`, `ics-output/`, `cron/`, or touch the
filesystem/network/clock (the current time is injected as `nowUtc`). This is
what makes it independently testable and deterministic — see
`test/scheduling-engine.test.ts` and `test/property/scheduling.property.test.ts`.

---

## 2. Setup instructions

Requires Node.js 22+.

```bash
cd study-scheduler
npm install
cp .env.example .env
# edit .env: STUDY_FEED_URL, STUDY_FEED_TOKEN, STUDY_ADMIN_TOKEN, STUDY_DOMAIN
npm run build
```

Run the test suite (optional but recommended before your first deploy):

```bash
npm test
```

### Running directly with Node

```bash
export $(grep -v '^#' .env | xargs)   # or use `dotenv`/your shell's env loading
npm run build
npm start
```

### Running with Docker

```bash
cp .env.example .env   # fill in real values
docker compose up -d --build
```

`docker-compose.yml` mounts `./schedule.js` and `./config/default.yaml`
read-only into the container and persists the SQLite database in a named
volume (`study-data`), so both survive container restarts/rebuilds.

> The Dockerfile was written and reviewed for correctness (multi-stage
> build, `better-sqlite3` native rebuild in the runtime stage) but could not
> be build-tested in the environment this was produced in, since no Docker
> daemon was available there. If `docker compose build` surfaces anything,
> it's most likely a `better-sqlite3` native-module/Node-ABI mismatch —
> pinning the `node:22-bookworm-slim` tag in both build and runtime stages
> to the same digest avoids that.

---

## 3. Configuration instructions

Edit `config/default.yaml`. The important parts:

```yaml
timezone: Europe/Paris

studyWindows:
  weekdays:
    - start: "11:30"
      end: "21:00"
  weekends:
    - start: "10:00"
      end: "14:00"
    - start: "20:00"
      end: "22:00"

reviews:
  - name: near
    targetOffsetDays: 1
    flexibilityDays: 1
  - name: far
    targetOffsetDays: 7
    flexibilityDays: 3

workload:
  preferredDailyMinutes: 180
  maxDailyMinutes: 270
  classLoadAdjustment:
    enabled: true
    minutesReducedPerClassHour: 30
    floorMinutes: 30

examProtection:
  blackoutDays: 7
  pullForwardMaxDays: 6
```

You can also set optional static blocked periods (see §"Unspecified
assumptions" below for why this exists):

```yaml
blockedPeriods:
  - startUtc: "2026-10-20T00:00:00.000Z"
    endUtc: "2026-10-22T00:00:00.000Z"
    reason: "Away for a wedding"
```

Config is validated with `zod` on load (`src/config/schema.ts`) — invalid
YAML fails fast with a readable error at startup.

You can also view/update the *running* config at runtime via
`GET /admin/config` / `PUT /admin/config` (see §9). A `PUT` is persisted in
the SQLite database and takes precedence over the YAML file until you either
`PUT` again or delete the database's `kv` row.

---

## 4. How to provide the university ICS URL

Set it via the `STUDY_FEED_URL` environment variable (recommended, keeps
secrets/personal URLs out of the checked-in YAML):

```bash
STUDY_FEED_URL="https://my-university.example/timetable/abc123.ics"
```

Or set `sourceFeed.url` directly in `config/default.yaml`. The env var, if
present, overrides the YAML value.

The feed is fetched with a timeout (`sourceFeed.fetchTimeoutSeconds`, default
15s) and a maximum response size (`sourceFeed.maxResponseBytes`, default 5MB)
to protect against a slow or misbehaving feed. It is **read-only input** —
never re-served or modified.

---

## 5. How to edit `schedule.js`

`schedule.js` is loaded fresh on every regeneration (startup, daily cron, and
manual). It's the *only* source of truth for exams/assessments — the
scheduler never infers exams from the university ICS feed.

```js
const EXAM_SCHEDULE = [
  {
    id: "algo-partiel-1",           // unique, stable id
    subject: "Algorithms",
    type: "partiel",                 // only types in config's protectedTypes create a blackout
    date: "2026-10-12",              // interpreted as Europe/Paris if no explicit timezone
    startTime: "09:00",              // or null for "protect the whole day"
    endTime: "11:00",                // or null
    title: "Algorithms — Partiel 1",
  },
];

const SEMESTER_START = "2026-09-01";

module.exports = { EXAM_SCHEDULE, SEMESTER_START };
```

After editing, either wait for the next daily regeneration or trigger one
immediately:

```bash
curl -X POST -H "Authorization: Bearer $STUDY_ADMIN_TOKEN" \
  http://localhost:3000/admin/regenerate
```

`schedule.js` stays plain CommonJS (`module.exports`) even though the rest
of the project is an ESM (`"type": "module"`) package — the loader
(`src/assessments/loadSchedule.ts`) evaluates it in its own CommonJS-shaped
sandbox rather than going through Node's normal `require`/`import`
resolution, specifically so this doesn't break.

---

## 6. How to start the service

```bash
npm run build
npm start
```

or, for local iteration without a build step:

```bash
npm run dev
```

or with Docker:

```bash
docker compose up -d
```

On startup the service runs one full regeneration immediately (same
pipeline as cron/manual), then starts the HTTP server and schedules the
daily cron job.

---

## 7. The generated ICS subscription URL

```
GET http://<your-host>:<port>/feeds/study.ics?token=<STUDY_FEED_TOKEN>
```

e.g.

```
https://my-server.example/feeds/study.ics?token=abc123yourtoken
```

Paste that URL into any calendar app that supports ICS subscriptions
(Apple Calendar, Google Calendar "From URL", Outlook, Fantastical, etc.).
The endpoint supports `ETag`/`If-None-Match` and `Last-Modified` for
efficient polling, and always returns the last successfully generated
calendar even if the most recent regeneration attempt failed.

---

## 8. How to manually regenerate

```bash
curl -X POST -H "Authorization: Bearer $STUDY_ADMIN_TOKEN" \
  http://localhost:3000/admin/regenerate
```

Returns the resulting `SchedulingRun` as JSON, synchronously. Returns
`409 Conflict` if a regeneration (cron, startup, or another manual call) is
already in progress.

Other useful admin endpoints (all require `Authorization: Bearer
$STUDY_ADMIN_TOKEN`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/sessions` | list all study sessions and their status |
| GET | `/admin/sessions/:id` | one session |
| POST | `/admin/sessions/:id/lock` | lock it in place; never auto-moved again |
| POST | `/admin/sessions/:id/skip` | omit it; never auto-reproposed |
| POST | `/admin/sessions/:id/unlock` | revert to normal auto-scheduling |
| POST | `/admin/sessions/:id/reschedule` | move it to an exact time and lock it there (body: `{"startUtc":"...","endUtc":"..."}`) |
| GET | `/admin/runs` | recent `SchedulingRun`s (`?limit=`) |
| GET | `/admin/runs/:id` | one run |
| GET | `/admin/config` | current effective config |
| PUT | `/admin/config` | replace the effective config (validated; persisted; triggers a regeneration) |

`lock`/`skip`/`unlock`/`reschedule` each append an override and then
synchronously trigger a regeneration, so the effect is visible immediately
in the next `GET /feeds/study.ics`.

---

## 9. How to run the tests

```bash
npm test          # vitest run (one-shot)
npm run test:watch
npm run typecheck  # tsc --noEmit
```

67 tests across 9 files, covering:

- `test/timezone.test.ts` — DST-correct zoned/UTC conversion (spring-forward and fall-back transitions)
- `test/ics-parse.test.ts` — recurring events, EXDATE, RECURRENCE-ID overrides, malformed events, missing/duplicate UIDs, floating vs. zoned vs. UTC times, out-of-range filtering
- `test/normalization.test.ts` — canonical ID stability, UID churn survival, moved-class re-identification
- `test/candidates.test.ts` — weekday/weekend window boundaries, 15-minute grid, the 14:00–20:00 weekend gap
- `test/assessments.test.ts` — `schedule.js` loading/validation (incl. as CJS under `"type":"module"`), exam blackout window computation
- `test/scheduling-engine.test.ts` — near/far placement, same-day exclusion, buffers, workload caps, `NEEDS_ATTENTION`, exam protection (all-subjects) + far-review pull-forward, LOCK/SKIP/UNLOCK/orphaned/cancelled semantics, determinism, stable IDs
- `test/ics-output.test.ts` — RFC 5545 shape, VTIMEZONE, review numbering (computed at render time, not stored), stable UIDs, status-based omission
- `test/pipeline.test.ts` — full pipeline against a real local HTTP feed: success, no-op, concurrency guard, abort-before-mutate on failure
- `test/property/scheduling.property.test.ts` — property-based (fast-check): across randomized class schedules, every placed study session fits its window, avoids its own class's day, and never overlaps or violates the buffer against any class or other study session

---

## 10. Genuinely unspecified assumptions

The task description said to use `study-scheduler-design.md` as the
authoritative design doc, with one explicit clarification (study windows).
The uploaded document *was* that clarification note plus the build
instructions — no separate, more detailed design document was provided
alongside it. Where the algorithm's exact behavior wasn't fully pinned down,
I made the following concrete, documented decisions:

1. **Canonical source-event identity ("UID-churn fallback") is
   content-based**, derived from `(normalized summary, exact start instant,
   exact end instant)` rather than from the ICS `UID`. This means a
   university feed that reissues UIDs on every export (common) is a
   non-issue by construction — the same class occurrence always gets the
   same `canonicalId`. The trade-off: if a class's summary *and* time both
   change in the same regeneration, it's treated as "old class cancelled,
   new class added" rather than "class moved" — which cascades correctly
   (old non-locked sessions cancel; a locked session survives as an
   orphan; a fresh pair of reviews gets scheduled for the new slot). See
   the comment in `src/normalization/canonicalId.ts`.

2. **Floating (no `TZID`, no trailing `Z`) DTSTART/DTEND values** are
   interpreted as wall-clock time in the scheduler's configured timezone
   (`Europe/Paris` by default) — the natural assumption for a university's
   own timetable feed.

3. **RRULE support covers `FREQ=DAILY` and `FREQ=WEEKLY`** (with
   `INTERVAL`, `BYDAY`, `COUNT`, `UNTIL`), which is what real-world
   university timetable exports use. An unsupported `FREQ` (e.g. MONTHLY)
   degrades to a single occurrence at `DTSTART` with a logged warning,
   rather than crashing or silently dropping the event.

4. **Blocked periods have no configuration surface in the design doc's
   sample YAML**, despite "respect configured blocked periods" being a
   required rule. I added an optional `blockedPeriods: [{startUtc, endUtc,
   reason}]` array to the config schema (empty by default) as the only
   place they can currently come from. There's no dedicated CRUD API for
   them (not in the listed HTTP routes either) — edit the config and
   `PUT /admin/config`, or the YAML file.

5. **`RESCHEDULE` has no dedicated HTTP route in the listed API**, even
   though it's a required override type. I added
   `POST /admin/sessions/:id/reschedule` (body: `{startUtc, endUtc}`) as
   the only way to invoke it, and treat a rescheduled session as
   effectively locked at its new position (consistent with "locked
   sessions are never auto-moved" being the mechanism that keeps a manual
   move from being overwritten on the next run).

6. **A `LOCK` on a session with no prior placement** (edge case — locking
   before any regeneration has ever placed it) falls through to the normal
   auto-scheduling algorithm once, and the resulting placement is then
   pinned as `LOCKED` for all future runs.

7. **Pull-forward is gated on the review literally named `"far"`** (matching
   the design doc's own wording, "far reviews may be pulled forward"),
   rather than being a generic per-review-type config flag. If you rename
   your review types, keep one named `far` for this behavior, or extend
   `runScheduling` (search for `reviewSpec.name === "far"`).

8. **The exam-protection blackout window** is `[assessmentDate −
   blackoutDays, assessmentEnd]` in local time (or the whole assessment day
   if no `startTime`/`endTime` is given), and applies to *all* subjects'
   study sessions during that window (per "scope: all-subjects" in the
   config) — i.e. it clears time for focused final review before any exam,
   not just the exam's own subject.

9. **Admin API authentication**: the design doc doesn't specify an auth
   mechanism for `/admin/*`. I gated all admin routes behind
   `Authorization: Bearer <STUDY_ADMIN_TOKEN>` (defaults to the same value
   as `STUDY_FEED_TOKEN` if not set separately), since this is explicitly a
   single-user personal service.

10. **Stability preference for auto-scheduled (non-locked) sessions**: on
    each regeneration, if a session's previous auto-placement is still
    valid under the current constraints, the engine keeps it rather than
    unconditionally re-running the full candidate search. This isn't a
    stated requirement, but it satisfies "do not simply destroy and
    recreate all sessions on every run" in spirit — sessions don't
    needlessly shuffle around just because the algorithm ran again with
    identical inputs (which is also what makes the engine idempotent; see
    the "determinism" tests).

11. **No-op detection** is described in the design doc purely in terms of
    the source feed hash. I broadened the signature that gates the no-op
    shortcut to also include `schedule.js`'s content hash, the effective
    config, and the overrides log — otherwise editing `schedule.js` or
    flipping a config value wouldn't take effect until the feed itself
    also happened to change. A `trigger: "manual"` regeneration always runs
    fully regardless, so `POST /admin/regenerate` never appears to silently
    do nothing.
