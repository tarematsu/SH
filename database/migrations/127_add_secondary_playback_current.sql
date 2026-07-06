CREATE TABLE IF NOT EXISTS sh_playback_channel_current (
  channel_alias TEXT PRIMARY KEY,
  station_id INTEGER,
  queue_id INTEGER,
  start_time INTEGER,
  is_paused INTEGER NOT NULL DEFAULT 0,
  is_broadcasting INTEGER NOT NULL DEFAULT 0,
  host_account_id INTEGER,
  host_handle TEXT,
  state_hash TEXT NOT NULL,
  queue_json TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  changed_at INTEGER NOT NULL
);
