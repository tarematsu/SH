-- Durable, optional comment collection tasks owned by the minute Worker.
-- The original minute fact is committed first; this task later ingests chat
-- history and requeues an idempotent correction with the final comment facts.
CREATE TABLE IF NOT EXISTS sh_minute_comment_tasks (
  task_id TEXT PRIMARY KEY,
  source_job_id TEXT NOT NULL UNIQUE,
  channel_id INTEGER NOT NULL,
  station_id INTEGER,
  minute_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sh_minute_comment_tasks_pending
  ON sh_minute_comment_tasks(status, next_attempt_at, minute_at);
