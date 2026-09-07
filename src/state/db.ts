import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS source_events (
  canonical_id TEXT PRIMARY KEY,
  raw_uid TEXT NOT NULL,
  recurrence_key TEXT,
  summary TEXT NOT NULL,
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  source_timezone TEXT,
  was_floating INTEGER NOT NULL,
  location TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_run_id TEXT
);

CREATE TABLE IF NOT EXISTS assessments_snapshot (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  title TEXT NOT NULL,
  last_seen_run_id TEXT
);

CREATE TABLE IF NOT EXISTS study_sessions (
  id TEXT PRIMARY KEY,
  source_canonical_id TEXT NOT NULL,
  source_summary TEXT NOT NULL,
  review_name TEXT NOT NULL,
  status TEXT NOT NULL,
  start_utc TEXT,
  end_utc TEXT,
  orphaned INTEGER NOT NULL,
  has_manual_override INTEGER NOT NULL,
  needs_attention_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS overrides (
  id TEXT PRIMARY KEY,
  study_session_id TEXT NOT NULL,
  action TEXT NOT NULL,
  new_start_utc TEXT,
  new_end_utc TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_overrides_session ON overrides(study_session_id);

CREATE TABLE IF NOT EXISTS scheduling_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  source_feed_hash TEXT,
  sessions_scheduled INTEGER NOT NULL DEFAULT 0,
  sessions_needs_attention INTEGER NOT NULL DEFAULT 0,
  sessions_cancelled INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDatabase(path: string): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
