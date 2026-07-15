-- Runtime-owned tables used by the minute Worker. Keeping these in migrations
-- removes CREATE/PRAGMA/index maintenance from cold Queue and cron invocations.

CREATE TABLE IF NOT EXISTS sh_minute_fact_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  minute_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  job_kind TEXT NOT NULL DEFAULT 'live',
  job_priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  processed_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(channel_id, minute_at)
);
CREATE INDEX IF NOT EXISTS idx_sh_minute_fact_jobs_pending
  ON sh_minute_fact_jobs(status, job_priority DESC, next_attempt_at, minute_at);

CREATE TABLE IF NOT EXISTS sh_minute_fact_runtime_state (
  task_name TEXT PRIMARY KEY,
  last_started_at INTEGER,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  last_duration_ms INTEGER,
  last_error TEXT,
  runs_total INTEGER NOT NULL DEFAULT 0,
  succeeded_total INTEGER NOT NULL DEFAULT 0,
  failed_total INTEGER NOT NULL DEFAULT 0,
  processed_total INTEGER NOT NULL DEFAULT 0,
  job_failures_total INTEGER NOT NULL DEFAULT 0,
  last_processed_count INTEGER NOT NULL DEFAULT 0,
  last_failed_count INTEGER NOT NULL DEFAULT 0,
  pending_count INTEGER NOT NULL DEFAULT 0,
  processing_count INTEGER NOT NULL DEFAULT 0,
  dead_count INTEGER NOT NULL DEFAULT 0,
  oldest_pending_minute INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sh_minute_fact_rebuild_state (
  rebuild_key TEXT PRIMARY KEY,
  cursor_observed_at INTEGER NOT NULL DEFAULT 0,
  cursor_snapshot_id INTEGER NOT NULL DEFAULT 0,
  last_snapshot_json TEXT,
  pending_json TEXT NOT NULL DEFAULT '[]',
  scanned_snapshots INTEGER NOT NULL DEFAULT 0,
  exact_candidates INTEGER NOT NULL DEFAULT 0,
  carried_candidates INTEGER NOT NULL DEFAULT 0,
  enqueued_jobs INTEGER NOT NULL DEFAULT 0,
  skipped_existing INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO sh_minute_fact_rebuild_state(rebuild_key,updated_at)
VALUES('snapshot-minute-facts-v1',0);
