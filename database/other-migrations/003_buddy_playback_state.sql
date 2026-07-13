-- Buddy-playback ("buddy46") state, split out of buddies' own database.
-- sh_worker_collector_state/sh_worker_auth_control/sh_playback_channel_current/
-- sh_collector_status are alias-keyed tables shared in schema with buddies'
-- own primary-loop tables of the same name in DB, but buddy46's rows never
-- overlap with buddies' own ('stationhead') rows. worker/src/buddy-runtime.js,
-- buddy-playback.js, buddy-raw-playback.js, and buddy-health.js write these
-- exclusively for buddy46 via the OTHER_DB binding.

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

CREATE TABLE IF NOT EXISTS sh_worker_auth_control (
  id TEXT PRIMARY KEY,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  lock_until INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sh_worker_auth_control_success
  ON sh_worker_auth_control(last_success_at DESC);

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
