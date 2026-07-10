CREATE TABLE IF NOT EXISTS sh_collector_status (
  collector_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  last_attempt_at INTEGER NOT NULL,
  last_success_at INTEGER,
  last_error TEXT,
  failure_code TEXT,
  failure_stage TEXT,
  failure_summary TEXT,
  failure_hint TEXT,
  tracks INTEGER,
  changed INTEGER,
  updated_at INTEGER NOT NULL
);
