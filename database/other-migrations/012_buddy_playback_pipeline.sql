-- Split buddy46 collection across several five-minute Cron invocations so the
-- Stationhead fetch, JSON parsing/normalization, metadata repair, and final
-- playback write do not share one Worker CPU budget.

CREATE TABLE IF NOT EXISTS sh_buddy_playback_pipeline (
  channel_alias TEXT PRIMARY KEY,
  cycle_at INTEGER NOT NULL,
  observed_at INTEGER,
  stage TEXT NOT NULL,
  raw_json TEXT,
  parsed_queue_json TEXT,
  state_json TEXT,
  final_queue_json TEXT,
  station_id INTEGER,
  queue_id INTEGER,
  start_time INTEGER,
  is_paused INTEGER,
  is_broadcasting INTEGER,
  host_account_id INTEGER,
  host_handle TEXT,
  track_count INTEGER NOT NULL DEFAULT 0,
  metadata_attempts INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sh_buddy_playback_pipeline_due
  ON sh_buddy_playback_pipeline(next_attempt_at, lease_until, updated_at);
