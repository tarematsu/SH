-- Storage owned exclusively by sh-monitor-buddies.
-- Other Workers and Pages must consume the FACTS_DB read model instead.

CREATE TABLE IF NOT EXISTS sh_channel_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at INTEGER NOT NULL,
  channel_id INTEGER,
  channel_alias TEXT,
  channel_name TEXT,
  station_id INTEGER,
  is_launched INTEGER,
  is_broadcasting INTEGER,
  chat_status TEXT,
  listener_count INTEGER,
  online_member_count INTEGER,
  total_member_count INTEGER,
  guest_count INTEGER,
  total_listens INTEGER,
  stream_goal INTEGER,
  current_stream_count INTEGER,
  host_account_id INTEGER,
  host_handle TEXT,
  broadcast_start_time INTEGER,
  raw_json TEXT NOT NULL,
  comment_velocity INTEGER,
  validated_stream_count INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sh_channel_snapshots_time
  ON sh_channel_snapshots(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_channel_snapshots_station_observed
  ON sh_channel_snapshots(station_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_channel_snapshots_host_account_observed
  ON sh_channel_snapshots(host_account_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_channel_snapshots_host_handle_observed
  ON sh_channel_snapshots(host_handle, observed_at DESC);

CREATE TABLE IF NOT EXISTS sh_snapshot_current (
  channel_key TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  last_snapshot_at INTEGER NOT NULL,
  last_stream_count INTEGER,
  last_stream_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sh_snapshot_current_time
  ON sh_snapshot_current(last_snapshot_at DESC);

CREATE TABLE IF NOT EXISTS sh_queue_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at INTEGER NOT NULL,
  station_id INTEGER,
  queue_id INTEGER,
  start_time INTEGER,
  is_paused INTEGER,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sh_queue_snapshots_time
  ON sh_queue_snapshots(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_queue_snapshots_station_observed
  ON sh_queue_snapshots(station_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_queue_snapshots_station_start_observed
  ON sh_queue_snapshots(station_id, start_time, observed_at DESC);

CREATE TABLE IF NOT EXISTS sh_queue_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at INTEGER NOT NULL,
  station_id INTEGER NOT NULL,
  queue_id INTEGER,
  start_time INTEGER NOT NULL,
  position INTEGER NOT NULL,
  queue_track_id INTEGER,
  stationhead_track_id INTEGER,
  spotify_id TEXT,
  apple_music_id TEXT,
  deezer_id TEXT,
  isrc TEXT,
  duration_ms INTEGER,
  preview_url TEXT,
  bite_count INTEGER,
  raw_json TEXT NOT NULL,
  UNIQUE(station_id, start_time, position)
);
CREATE INDEX IF NOT EXISTS idx_sh_queue_items_isrc_observed_spotify
  ON sh_queue_items(isrc, observed_at DESC, spotify_id);

CREATE TABLE IF NOT EXISTS sh_queue_current (
  station_id INTEGER PRIMARY KEY,
  queue_id INTEGER,
  start_time INTEGER,
  structural_hash TEXT NOT NULL,
  likes_hash TEXT,
  is_paused INTEGER,
  observed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sh_queue_current_observed
  ON sh_queue_current(observed_at DESC);

CREATE TABLE IF NOT EXISTS sh_track_like_current (
  station_id INTEGER NOT NULL,
  track_key TEXT NOT NULL,
  queue_id INTEGER,
  start_time INTEGER,
  position INTEGER,
  queue_track_id INTEGER,
  stationhead_track_id INTEGER,
  spotify_id TEXT,
  apple_music_id TEXT,
  isrc TEXT,
  like_count INTEGER,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY(station_id, track_key)
);
CREATE INDEX IF NOT EXISTS idx_sh_track_like_current_observed
  ON sh_track_like_current(observed_at DESC);

CREATE TABLE IF NOT EXISTS sh_track_like_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at INTEGER NOT NULL,
  station_id INTEGER,
  queue_id INTEGER,
  start_time INTEGER,
  position INTEGER,
  queue_track_id INTEGER,
  stationhead_track_id INTEGER,
  spotify_id TEXT,
  apple_music_id TEXT,
  isrc TEXT,
  track_key TEXT NOT NULL,
  like_count INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'collector',
  raw_json TEXT,
  UNIQUE(observed_at, station_id, track_key)
);
CREATE INDEX IF NOT EXISTS idx_sh_track_like_observations_station_track_time
  ON sh_track_like_observations(station_id, track_key, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_track_like_observations_time
  ON sh_track_like_observations(observed_at DESC);

CREATE TABLE IF NOT EXISTS sh_track_metadata (
  spotify_id TEXT PRIMARY KEY,
  title TEXT,
  artist TEXT,
  display_title TEXT,
  thumbnail_url TEXT,
  spotify_url TEXT,
  source TEXT NOT NULL DEFAULT 'spotify_oembed',
  fetched_at INTEGER NOT NULL,
  raw_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_sh_track_metadata_fetched_at
  ON sh_track_metadata(fetched_at DESC);

CREATE TABLE IF NOT EXISTS sh_comment_state (
  station_id INTEGER PRIMARY KEY,
  last_comment_id INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  last_observed_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sh_comment_minute_counts (
  station_id INTEGER NOT NULL,
  bucket_start INTEGER NOT NULL,
  comment_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(station_id, bucket_start)
);
CREATE INDEX IF NOT EXISTS idx_sh_comment_minute_counts_bucket
  ON sh_comment_minute_counts(bucket_start DESC);
CREATE TABLE IF NOT EXISTS sh_comment_daily_counts (
  station_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  comment_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(station_id, day_key)
);

CREATE TABLE IF NOT EXISTS sh_collector_heartbeats (
  collector_id TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  hostname TEXT,
  version TEXT,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_sh_collector_heartbeats_last_seen
  ON sh_collector_heartbeats(last_seen_at DESC);

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
  lock_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sh_worker_auth_control_success
  ON sh_worker_auth_control(last_success_at DESC);

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

CREATE TABLE IF NOT EXISTS sh_ingest_claims (
  dedupe_key TEXT PRIMARY KEY,
  data_type TEXT NOT NULL,
  collector_id TEXT NOT NULL,
  collector_kind TEXT NOT NULL,
  source_priority INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sh_ingest_claims_type_time
  ON sh_ingest_claims(data_type, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_ingest_claims_collector_time
  ON sh_ingest_claims(collector_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS sh_ingest_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL,
  data_type TEXT NOT NULL,
  canonical_collector_id TEXT,
  canonical_priority INTEGER,
  canonical_hash TEXT,
  incoming_collector_id TEXT NOT NULL,
  incoming_priority INTEGER NOT NULL,
  incoming_hash TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  detected_at INTEGER NOT NULL,
  resolution TEXT NOT NULL,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_sh_ingest_conflicts_key_time
  ON sh_ingest_conflicts(dedupe_key, detected_at DESC);

CREATE TABLE IF NOT EXISTS sh_data_maintenance_state (
  id TEXT PRIMARY KEY,
  last_rollup_key TEXT,
  last_cleanup_at INTEGER NOT NULL DEFAULT 0,
  legacy_backfill_id INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sh_primary_run_lock (
  scope TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL
);
