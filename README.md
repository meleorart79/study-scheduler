# study-scheduler

A single-user personal service that turns your university ICS timetable into
an automatically-scheduled calendar of spaced study/review sessions, served
as its own ICS subscription URL — alongside your recurring commitments
(e.g. basketball) so your week reads as one coherent schedule instead of
study sessions with unexplained gaps in them.

```
University ICS  →  scheduling engine  →  Study ICS (subscribe from your calendar app)
schedule.js (exams + holidays)  ──────────────┘
```

The university feed and `schedule.js` are read-only input. `schedule.js` is
the sole source of truth for exams/holidays. Everything else (study session
placement, locks, skips) is computed and persisted by this service.

---

## 1. Project structure

```
study-scheduler/
├── config/
│   └── default.yaml          # default configuration (study windows, workload, etc.)
├── schedule.js                # YOUR exam/holiday schedule (edit this)
├── src/
│   ├── ics-input/              # fetch + parse + expand recurrence (RRULE/EXDATE/overrides)
│   ├── normalization/          # raw events -> stable SourceEvents (canonical IDs)
│   ├── assessments/            # loads schedule.js, computes exam blackouts + holiday periods
│   ├── scheduling/             # the pure scheduling engine (no I/O)
│   ├── state/                  # SQLite persistence
│   ├── ics-output/              # generates the study.ics + school.ics calendars
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
what makes it independently testable and deterministic.

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
export $(grep -v '^#' .env | xargs)
npm run build
npm start
```

### Running with Docker

```bash
cp .env.example .env
docker compose up -d --build
```

`docker-compose.yml` mounts `./schedule.js` and `./config/default.yaml`
read-only into the container and persists the SQLite database in a named
volume (`study-data`), so both survive container restarts/rebuilds.

---

## 3. Configuration instructions

Edit `config/default.yaml`. The important parts:

```yaml
timezone: Europe/Paris

studyWindows:
  weekdays:
    - start: "11:30"
      end: "21:00"       # your bedtime cutoff — see §3a
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
    anySlot: true          # see §3b

workload:
  preferredDailyMinutes: 180
  maxDailyMinutes: null    # see §3a
  classLoadAdjustment:
    enabled: true
    minutesReducedPerClassHour: 20
    floorMinutes: 60

recurringBlockedPeriods:    # see §3c
  - weekday: "monday"
    start: "12:00"
    end: "13:30"
    reason: "Basketball"
    visible: true

examProtection:
  scope: all-subjects
  blackoutDays: 7
  pullForwardMaxDays: 6
```

You can also set optional static blocked periods:

```yaml
blockedPeriods:
  - startUtc: "2026-10-20T00:00:00.000Z"
    endUtc: "2026-10-22T00:00:00.000Z"
    reason: "Away for a wedding"
    visible: true   # default; set false to keep it hidden but still blocked
```

Config is validated with `zod` on load (`src/config/schema.ts`) — invalid
YAML fails fast with a readable error at startup.

You can also view/update the *running* config at runtime via
`GET /admin/config` / `PUT /admin/config`. A `PUT` is persisted in the
SQLite database and takes precedence over the YAML file until you either
`PUT` again or delete the database's `kv` row.

### 3a. No daily study-time cap — bedtime is the only limit

`workload.maxDailyMinutes` is `null` by default, which disables the hard
daily cap entirely. The only thing that then limits how much studying gets
packed into a given day is how many 90-minute sessions physically fit
inside that day's `studyWindows` — in other words, whatever time you set as
the end of your window *is* your bedtime cutoff. Set `maxDailyMinutes` back
to a number (e.g. `270`) if you ever want an explicit cap again;
`preferredDailyMinutes` is unaffected either way — it's a *soft* ranking
preference (sessions still prefer lighter days first), never a hard block.

### 3b. The "far" review is first-fit, not target-seeking

`anySlot: true` on a review (the shipped default for `far`) means it
ignores `targetOffsetDays`/`flexibilityDays` completely and just takes the
first available slot anywhere from the day after its class through the end
of the configured horizon (`horizon.lookaheadDays`), in chronological
order. No distance-based ranking, no pull-forward logic — first fit that
respects buffers, workload, blocked periods, and exam blackouts wins.
`near` still uses the classic `targetOffsetDays ± flexibilityDays` window.

### 3c. Recurring commitments (basketball) — visible or silent

Each entry under `recurringBlockedPeriods` blocks that weekly slot from
ever getting a study session placed in it. Set `visible: true` (the
default) and it also gets rendered as its own event in `study.ics`, right
alongside your review sessions, so it reads as "Basketball" on your
calendar instead of a mysterious gap. Set `visible: false` for a
commitment you want blocked but don't need to see on this particular
calendar (e.g. because it's already on another calendar you subscribe to).
The same `visible` flag also works on static `blockedPeriods` entries
(§3, above) — e.g. a one-off "Away for a wedding" block can render as its
own event too.

Basketball (or any recurring commitment) is automatically **suppressed**
— both blocked-and-hidden from scheduling *and* absent from the visible
calendar — during:
- the exam-protection blackout window (see §3d) for any protected
  assessment, and
- any period listed in `schedule.js`'s `HOLIDAYS_SCHEDULE` (see §5).

So during exam-prep week, exam week itself, and holidays, you won't see
basketball on the calendar and it won't eat into your study time — because
it isn't happening then.

### 3d. Exam blackouts span the whole exam period

Partiels are a week, not a single day. An assessment's blackout window is
`[date − blackoutDays, endDate + end-of-day]` in local time — set
`endDate` in `schedule.js` for any multi-day assessment (see §5); it
defaults to `date` for a single-day one. The blackout is
`scope: all-subjects`, so it clears every subject's study sessions for
focused exam-week review, not just the subject being examined.

---

## 4. How to provide the university ICS URL

Set it via the `STUDY_FEED_URL` environment variable (recommended, keeps
secrets/personal URLs out of the checked-in YAML):

```bash
STUDY_FEED_URL="https://my-university.example/timetable/abc123.ics"
```

Or point `sourceFeed.file` at a locally exported `.ics` instead (see
`.env.example` — `STUDY_FEED_FILE`). Exactly one of `url`/`file` must be
set; the env var, if present, overrides the YAML value.

The feed is fetched with a timeout (`sourceFeed.fetchTimeoutSeconds`,
default 15s) and a maximum response size (`sourceFeed.maxResponseBytes`,
default 5MB). It is **read-only input** — never re-served or modified.

---

## 5. How to edit `schedule.js`

`schedule.js` is loaded fresh on every regeneration (startup, daily cron,
and manual). It's the *only* source of truth for exams and holidays — the
scheduler never infers either from the university ICS feed.

```js
const EXAM_SCHEDULE = [
  {
    id: "algo-partiel-1",           // unique, stable id
    subject: "Algorithms",
    type: "partiel",                 // only types in config's protectedTypes create a blackout
    date: "2026-10-19",              // first day, interpreted as Europe/Paris if no explicit timezone
    endDate: "2026-10-23",           // last day (defaults to `date` if omitted — single-day exam)
    startTime: null,                 // or "09:00" for a same-day exam with a known start
    endTime: null,                   // or "11:00"
    title: "Partiels 1 — 19–23 October",
  },
];

// Basketball (and any other recurring commitment) is automatically paused
// during any window listed here.
const HOLIDAYS_SCHEDULE = [
  { name: "Vacances d'automne", startDate: "2026-10-26T00:00:00", endDate: "2026-10-31T23:59:59" },
  { name: "Vacances de Noël",   startDate: "2026-12-21T00:00:00", endDate: "2027-01-03T23:59:59" },
  { name: "Vacances d'hiver",   startDate: "2027-02-15T00:00:00", endDate: "2027-02-21T23:59:59" },
  { name: "Vacances de printemps", startDate: "2027-04-05T00:00:00", endDate: "2027-04-18T23:59:59" },
];

const SEMESTER_START = "2026-09-01";

module.exports = { EXAM_SCHEDULE, HOLIDAYS_SCHEDULE, SEMESTER_START };
```

Holiday dates are floating local datetimes (`YYYY-MM-DDTHH:mm:ss`),
interpreted as Europe/Paris — same convention as exam dates.

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

## 7. The generated ICS subscription URLs

```
GET http://<your-host>:<port>/feeds/study.ics?token=<STUDY_FEED_TOKEN>
GET http://<your-host>:<port>/feeds/school.ics?token=<STUDY_FEED_TOKEN>
```

- **`study.ics`** — your scheduled review sessions *plus* any recurring
  commitment or static blocked period marked `visible: true` (e.g.
  basketball, or a one-off travel block), so the whole week reads as one
  schedule instead of study sessions with gaps in them.
- **`school.ics`** — a pure pass-through of your university timetable, no
  study sessions, so you can show/hide classes independently in your
  calendar app.

Paste either URL into any calendar app that supports ICS subscriptions
(Apple Calendar, Google Calendar "From URL", Outlook, Fantastical, etc.).
Both endpoints support `ETag`/`If-None-Match` and `Last-Modified`, and
always return the last successfully generated calendar even if the most
recent regeneration attempt failed.

---

## 8. How to manually regenerate

```bash
curl -X POST -H "Authorization: Bearer $STUDY_ADMIN_TOKEN" \
  http://localhost:3000/admin/regenerate
```

Returns the resulting `SchedulingRun` as JSON, synchronously. Returns
`409 Conflict` if a regeneration is already in progress.

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

Covering:

- `test/timezone.test.ts` — DST-correct zoned/UTC conversion
- `test/ics-parse.test.ts` — recurring events, EXDATE, RECURRENCE-ID overrides, malformed events, floating vs. zoned vs. UTC times, range filtering
- `test/normalization.test.ts` — canonical ID stability, UID churn survival, moved-class re-identification
- `test/candidates.test.ts` — weekday/weekend window boundaries, 15-minute grid, the weekend gap
- `test/assessments.test.ts` — `schedule.js` loading/validation, multi-day exam blackout windows, holiday period computation
- `test/scheduling-engine.test.ts` — near placement, first-fit ("anySlot") far-review placement, same-day exclusion, buffers, unlimited-workload behavior, `NEEDS_ATTENTION`, exam protection (all-subjects, multi-day), LOCK/SKIP/UNLOCK/orphaned/cancelled semantics, determinism, stable IDs
- `test/ics-output.test.ts` — RFC 5545 shape, VTIMEZONE, review numbering, visible recurring/static commitments rendered as events, stable UIDs, status-based omission
- `test/pipeline.test.ts` — full pipeline against a real local HTTP feed: success, no-op, concurrency guard, abort-before-mutate on failure
- `test/property/scheduling.property.test.ts` — property-based (fast-check): across randomized class schedules, every placed study session fits its window, avoids its own class's day, and never overlaps or violates the buffer against any class or other study session

---

## 10. Genuinely unspecified assumptions

1. **Canonical source-event identity is content-based** — derived from
   `(normalized summary, exact start instant, exact end instant)` rather
   than the ICS `UID`, so a university feed that reissues UIDs on every
   export is a non-issue by construction. See
   `src/normalization/canonicalId.ts` for the full rationale and the
   trade-off (a class that changes both summary *and* time in the same
   regeneration reads as "old class cancelled, new class added").

2. **Floating (no `TZID`, no trailing `Z`) DTSTART/DTEND values** are
   interpreted as wall-clock time in the scheduler's configured timezone.

3. **RRULE support covers `FREQ=DAILY` and `FREQ=WEEKLY`** (with
   `INTERVAL`, `BYDAY`, `COUNT`, `UNTIL`). An unsupported `FREQ` degrades
   to a single occurrence at `DTSTART` with a logged warning.

4. **Blocked periods have no dedicated CRUD API** — edit `config/default.yaml`'s
   `blockedPeriods`/`recurringBlockedPeriods`, or `PUT /admin/config`.

5. **`RESCHEDULE` has no dedicated route in the original spec's listed
   API**; `POST /admin/sessions/:id/reschedule` was added as the only way
   to invoke it, treated as equivalent to a `LOCK` at the new position.

6. **A `LOCK` on a session with no prior placement** falls through to
   normal auto-scheduling once, then the result is pinned as `LOCKED`.

7. **First-fit (`anySlot`) is opt-in per review**, not a global mode —
   `near` keeps its target/flexibility window; only `far` is first-fit by
   default. Toggle per-review in `config/default.yaml`.

8. **The exam-protection blackout window** covers `[date − blackoutDays,
   endDate's end-of-day]`, all-subjects. A same-day exam with an explicit
   `endTime` is protected only through that exact moment; anything
   multi-day or without a time is protected through the end of its last
   day.

9. **Holiday periods are hard blocks for everything** — classes, study
   sessions, and recurring commitments alike — not just a basketball
   suppression window. They come from `schedule.js`'s `HOLIDAYS_SCHEDULE`,
   the same file that owns exams, since both are "dates the school year
   itself defines" rather than personal scheduling preference.

10. **Commitment visibility is per-rule, not global** — `visible:
    true`/`false` on each `recurringBlockedPeriods` entry *and* each
    static `blockedPeriods` entry, so you can mix commitments you want to
    see on this calendar with ones you only need blocked (e.g. because
    they're already on another calendar).

11. **No daily study-time cap by default** (`workload.maxDailyMinutes:
    null`) — a deliberate departure from an earlier version of this
    config that had an explicit 270-minute cap. The study windows
    themselves are now the only enforced limit, on the reasoning that "how
    long is too long to study" is a personal, day-dependent judgment call
    better made by adjusting your window's end time (bedtime) than by a
    fixed minute budget.

12. **Admin API authentication**: gated behind `Authorization: Bearer
    <STUDY_ADMIN_TOKEN>` (defaults to `STUDY_FEED_TOKEN` if unset), since
    this is explicitly a single-user personal service.

13. **Stability preference for auto-scheduled (non-locked) sessions**: on
    each regeneration, if a session's previous placement is still valid
    under current constraints, it's kept rather than re-run from scratch —
    sessions don't shuffle just because the algorithm ran again with
    identical inputs.

14. **No-op detection** includes the source feed hash, `schedule.js`'s
    content hash, the effective config, and the overrides log, so editing
    `schedule.js` or flipping a config value always takes effect. A
    `trigger: "manual"` regeneration always runs fully regardless.
