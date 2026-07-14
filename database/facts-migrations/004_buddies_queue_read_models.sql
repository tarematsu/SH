-- Public read model populated by the minute worker's Queue consumer.
-- The buddies collector never binds to or writes FACTS_DB directly.

CREATE TABLE IF NOT EXISTS sh_minute_fact_queue_receipts (
  job_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sh_minute_fact_queue_receipts_received
  ON sh_minute_fact_queue_receipts(received_at DESC);

CREATE TABLE IF NOT EXISTS sh_channel_read_model (
  channel_id INTEGER PRIMARY KEY,
  observed_at INTEGER NOT NULL,
  presentation_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sh_channel_read_model_observed
  ON sh_channel_read_model(observed_at DESC);

CREATE TABLE IF NOT EXISTS sh_queue_read_model_current (
  channel_id INTEGER PRIMARY KEY,
  observed_at INTEGER NOT NULL,
  station_id INTEGER,
  queue_id INTEGER,
  start_time INTEGER,
  is_paused INTEGER,
  queue_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_sh_queue_read_model_observed
  ON sh_queue_read_model_current(observed_at DESC);

CREATE TABLE IF NOT EXISTS sh_collector_read_model (
  collector_id TEXT PRIMARY KEY,
  last_run_at INTEGER,
  last_success_at INTEGER,
  last_error_present INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sh_collector_read_model_updated
  ON sh_collector_read_model(updated_at DESC);
