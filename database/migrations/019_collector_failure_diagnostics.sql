CREATE TABLE IF NOT EXISTS sh_collector_failure_state (
  id TEXT PRIMARY KEY,
  first_failure_at INTEGER NOT NULL,
  last_failure_at INTEGER NOT NULL,
  code TEXT NOT NULL,
  stage TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  hint TEXT,
  source TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sh_collector_failure_state_time
  ON sh_collector_failure_state(last_failure_at DESC);
