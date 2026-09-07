import type Database from "better-sqlite3";
import type {
  Assessment,
  Override,
  OverrideAction,
  SchedulingRun,
  SourceEvent,
  StudySession,
} from "../types.js";

export class Repository {
  constructor(private db: Database.Database) {}

  // --- source events ---

  getAllSourceEvents(): SourceEvent[] {
    const rows = this.db.prepare(`SELECT * FROM source_events`).all() as any[];
    return rows.map(rowToSourceEvent);
  }

  replaceSourceEvents(events: SourceEvent[]): void {
    const tx = this.db.transaction((evs: SourceEvent[]) => {
      this.db.prepare(`DELETE FROM source_events`).run();
      const stmt = this.db.prepare(`
        INSERT INTO source_events
          (canonical_id, raw_uid, recurrence_key, summary, start_utc, end_utc,
           source_timezone, was_floating, location, first_seen_at, last_seen_run_id)
        VALUES (@canonicalId, @rawUid, @recurrenceKey, @summary, @startUtc, @endUtc,
                @sourceTimezone, @wasFloating, @location, @firstSeenAt, @lastSeenRunId)
      `);
      for (const e of evs) {
        stmt.run({ ...e, wasFloating: e.wasFloating ? 1 : 0 });
      }
    });
    tx(events);
  }

  // --- assessments (persisted snapshot only; schedule.js remains source of truth) ---

  replaceAssessmentsSnapshot(assessments: Assessment[], runId: string): void {
    const tx = this.db.transaction((items: Assessment[]) => {
      this.db.prepare(`DELETE FROM assessments_snapshot`).run();
      const stmt = this.db.prepare(`
        INSERT INTO assessments_snapshot
          (id, subject, type, date, start_time, end_time, title, last_seen_run_id)
        VALUES (@id, @subject, @type, @date, @startTime, @endTime, @title, @runId)
      `);
      for (const a of items) {
        stmt.run({ ...a, runId });
      }
    });
    tx(assessments);
  }

  // --- study sessions ---

  getAllStudySessions(): StudySession[] {
    const rows = this.db.prepare(`SELECT * FROM study_sessions`).all() as any[];
    return rows.map(rowToStudySession);
  }

  getStudySession(id: string): StudySession | null {
    const row = this.db.prepare(`SELECT * FROM study_sessions WHERE id = ?`).get(id) as any;
    return row ? rowToStudySession(row) : null;
  }

  replaceStudySessions(sessions: StudySession[]): void {
    const tx = this.db.transaction((items: StudySession[]) => {
      this.db.prepare(`DELETE FROM study_sessions`).run();
      const stmt = this.db.prepare(`
        INSERT INTO study_sessions
          (id, source_canonical_id, source_summary, review_name, status, start_utc, end_utc,
           orphaned, has_manual_override, needs_attention_reason, created_at, updated_at)
        VALUES (@id, @sourceCanonicalId, @sourceSummary, @reviewName, @status, @startUtc, @endUtc,
                @orphaned, @hasManualOverride, @needsAttentionReason, @createdAt, @updatedAt)
      `);
      for (const s of items) {
        stmt.run({
          ...s,
          orphaned: s.orphaned ? 1 : 0,
          hasManualOverride: s.hasManualOverride ? 1 : 0,
        });
      }
    });
    tx(sessions);
  }

  // --- overrides (append-only log) ---

  getAllOverrides(): Override[] {
    const rows = this.db.prepare(`SELECT * FROM overrides ORDER BY created_at ASC`).all() as any[];
    return rows.map(rowToOverride);
  }

  insertOverride(o: Override): void {
    this.db
      .prepare(
        `INSERT INTO overrides (id, study_session_id, action, new_start_utc, new_end_utc, created_at)
         VALUES (@id, @studySessionId, @action, @newStartUtc, @newEndUtc, @createdAt)`
      )
      .run(o);
  }

  // --- scheduling runs ---

  insertRun(run: SchedulingRun): void {
    this.db
      .prepare(
        `INSERT INTO scheduling_runs
          (id, trigger, status, started_at, finished_at, source_feed_hash,
           sessions_scheduled, sessions_needs_attention, sessions_cancelled, error)
         VALUES (@id, @trigger, @status, @startedAt, @finishedAt, @sourceFeedHash,
                 @sessionsScheduled, @sessionsNeedsAttention, @sessionsCancelled, @error)`
      )
      .run(run);
  }

  updateRun(run: SchedulingRun): void {
    this.db
      .prepare(
        `UPDATE scheduling_runs SET
           status=@status, finished_at=@finishedAt, source_feed_hash=@sourceFeedHash,
           sessions_scheduled=@sessionsScheduled, sessions_needs_attention=@sessionsNeedsAttention,
           sessions_cancelled=@sessionsCancelled, error=@error
         WHERE id=@id`
      )
      .run(run);
  }

  getRun(id: string): SchedulingRun | null {
    const row = this.db.prepare(`SELECT * FROM scheduling_runs WHERE id = ?`).get(id) as any;
    return row ? rowToRun(row) : null;
  }

  listRuns(limit = 50): SchedulingRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM scheduling_runs ORDER BY started_at DESC LIMIT ?`)
      .all(limit) as any[];
    return rows.map(rowToRun);
  }

  getLatestSuccessfulFeedHash(): string | null {
    const row = this.db
      .prepare(
        `SELECT source_feed_hash FROM scheduling_runs
         WHERE status = 'SUCCESS' OR status = 'NO_OP'
         ORDER BY started_at DESC LIMIT 1`
      )
      .get() as any;
    return row?.source_feed_hash ?? null;
  }

  // --- kv (runtime config override, last-good ICS cache) ---

  getKv(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as any;
    return row?.value ?? null;
  }

  setKv(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }
}

function rowToSourceEvent(row: any): SourceEvent {
  return {
    canonicalId: row.canonical_id,
    rawUid: row.raw_uid,
    recurrenceKey: row.recurrence_key,
    summary: row.summary,
    startUtc: row.start_utc,
    endUtc: row.end_utc,
    sourceTimezone: row.source_timezone,
    wasFloating: Boolean(row.was_floating),
    location: row.location,
    firstSeenAt: row.first_seen_at,
    lastSeenRunId: row.last_seen_run_id,
  };
}

function rowToStudySession(row: any): StudySession {
  return {
    id: row.id,
    sourceCanonicalId: row.source_canonical_id,
    sourceSummary: row.source_summary,
    reviewName: row.review_name,
    status: row.status,
    startUtc: row.start_utc,
    endUtc: row.end_utc,
    orphaned: Boolean(row.orphaned),
    hasManualOverride: Boolean(row.has_manual_override),
    needsAttentionReason: row.needs_attention_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToOverride(row: any): Override {
  return {
    id: row.id,
    studySessionId: row.study_session_id,
    action: row.action as OverrideAction,
    newStartUtc: row.new_start_utc,
    newEndUtc: row.new_end_utc,
    createdAt: row.created_at,
  };
}

function rowToRun(row: any): SchedulingRun {
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    sourceFeedHash: row.source_feed_hash,
    sessionsScheduled: row.sessions_scheduled,
    sessionsNeedsAttention: row.sessions_needs_attention,
    sessionsCancelled: row.sessions_cancelled,
    error: row.error,
  };
}
