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
  comment_velocity INTEGER,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sh_sh_channel_snapshots_time ON sh_channel_snapshots(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_channel_snapshots_station_observed ON sh_channel_snapshots(station_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_channel_snapshots_host_account_observed ON sh_channel_snapshots(host_account_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_channel_snapshots_host_handle_observed ON sh_channel_snapshots(host_handle, observed_at DESC);

CREATE TABLE IF NOT EXISTS sh_comments (
  id INTEGER PRIMARY KEY,
  observed_at INTEGER NOT NULL,
  station_id INTEGER,
  account_id INTEGER,
  handle TEXT,
  text TEXT,
  text_with_xml TEXT,
  chat_time INTEGER,
  chat_time_ms INTEGER,
  all_access_chat INTEGER,
  boost_chat INTEGER,
  active_stream_days INTEGER,
  followers INTEGER,
  following INTEGER,
  emoji TEXT,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sh_sh_comments_time ON sh_comments(chat_time_ms DESC);
CREATE INDEX IF NOT EXISTS idx_sh_sh_comments_account ON sh_comments(account_id);

CREATE TABLE IF NOT EXISTS sh_queue_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at INTEGER NOT NULL,
  station_id INTEGER,
  queue_id INTEGER,
  start_time INTEGER,
  is_paused INTEGER,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sh_sh_queue_snapshots_time ON sh_queue_snapshots(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_queue_snapshots_station_observed ON sh_queue_snapshots(station_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_queue_snapshots_station_start_observed ON sh_queue_snapshots(station_id, start_time, observed_at DESC);

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
CREATE INDEX IF NOT EXISTS idx_sh_sh_queue_items_spotify ON sh_queue_items(spotify_id);
CREATE INDEX IF NOT EXISTS idx_sh_queue_items_isrc_observed_spotify
  ON sh_queue_items(isrc, observed_at DESC, spotify_id);

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

CREATE TABLE IF NOT EXISTS sh_raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  channel TEXT,
  event TEXT,
  data_json TEXT,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sh_sh_raw_events_time ON sh_raw_events(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_sh_raw_events_event ON sh_raw_events(event);

CREATE TABLE IF NOT EXISTS sh_realtime_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at INTEGER NOT NULL,
  event TEXT NOT NULL,
  listener_count INTEGER,
  online_member_count INTEGER,
  stream_goal INTEGER,
  current_stream_count INTEGER,
  account_id INTEGER,
  change_type TEXT,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sh_sh_realtime_metrics_time ON sh_realtime_metrics(observed_at DESC);


CREATE TABLE IF NOT EXISTS sh_track_metadata (
  spotify_id TEXT PRIMARY KEY,
  isrc TEXT,
  title TEXT,
  artist TEXT,
  display_title TEXT,
  thumbnail_url TEXT,
  spotify_url TEXT,
  source TEXT NOT NULL DEFAULT 'spotify_oembed',
  fetched_at INTEGER NOT NULL,
  raw_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_sh_track_metadata_fetched_at ON sh_track_metadata(fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_track_metadata_isrc_fetched
  ON sh_track_metadata(isrc, fetched_at DESC)
  WHERE isrc IS NOT NULL AND isrc <> '';

CREATE TABLE IF NOT EXISTS sh_collector_heartbeats (
  collector_id TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  hostname TEXT,
  version TEXT,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_sh_collector_heartbeats_last_seen ON sh_collector_heartbeats(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS sh_spotify_playlist_state (
  playlist_id TEXT PRIMARY KEY,
  playlist_url TEXT NOT NULL,
  playlist_name TEXT,
  track_count INTEGER,
  queue_hash TEXT,
  synchronized_at INTEGER NOT NULL,
  collector_id TEXT,
  raw_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_sh_spotify_playlist_sync ON sh_spotify_playlist_state(synchronized_at DESC);
