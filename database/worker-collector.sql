CREATE TABLE IF NOT EXISTS sh_worker_collector_state (
  id TEXT PRIMARY KEY,
  auth_token TEXT NOT NULL,
  device_uid TEXT NOT NULL,
  token_expires_at INTEGER,
  last_run_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  last_channel_id INTEGER,
  last_station_id INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sh_worker_collector_state_success
  ON sh_worker_collector_state(last_success_at DESC);
