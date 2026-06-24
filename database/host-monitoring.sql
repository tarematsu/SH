CREATE TABLE IF NOT EXISTS sh_host_profile_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at INTEGER NOT NULL,
  source_scope TEXT NOT NULL DEFAULT 'profile_monitor',
  session_id INTEGER,
  handle TEXT NOT NULL,
  account_id INTEGER,
  followers INTEGER,
  following INTEGER,
  total_streams INTEGER,
  active_stream_days INTEGER,
  emoji TEXT,
  thumbnail_url TEXT,
  medium_url TEXT,
  main_url TEXT,
  badges_json TEXT,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_sh_host_profile_handle_time
ON sh_host_profile_snapshots(handle, observed_at);

CREATE TABLE IF NOT EXISTS sh_host_broadcast_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_scope TEXT NOT NULL,
  handle TEXT NOT NULL,
  account_id INTEGER,
  station_id INTEGER NOT NULL,
  broadcast_id INTEGER,
  broadcast_stream_id TEXT,
  started_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  ended_at INTEGER,
  status TEXT NOT NULL,
  detection_reason TEXT,
  end_reason TEXT,
  buddies_station_id INTEGER,
  channel_id INTEGER,
  channel_alias TEXT,
  total_listens_start INTEGER,
  total_listens_end INTEGER,
  followers_start INTEGER,
  followers_end INTEGER,
  total_streams_start INTEGER,
  total_streams_end INTEGER,
  peak_listeners INTEGER,
  listener_sum INTEGER NOT NULL DEFAULT 0,
  listener_sample_count INTEGER NOT NULL DEFAULT 0,
  average_listeners REAL,
  track_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  last_observed_at INTEGER,
  raw_start_json TEXT,
  raw_end_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sh_host_session_identity
ON sh_host_broadcast_sessions(source_scope, handle, station_id, started_at);

CREATE INDEX IF NOT EXISTS idx_sh_host_sessions_handle_start
ON sh_host_broadcast_sessions(handle, started_at);

CREATE INDEX IF NOT EXISTS idx_sh_host_sessions_status
ON sh_host_broadcast_sessions(status, last_observed_at);

CREATE TABLE IF NOT EXISTS sh_host_station_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  source_scope TEXT,
  handle TEXT,
  account_id INTEGER,
  station_id INTEGER,
  broadcast_id INTEGER,
  broadcast_start_time INTEGER,
  is_broadcasting INTEGER,
  status TEXT,
  chat_status TEXT,
  listener_count INTEGER,
  guest_count INTEGER,
  total_listens INTEGER,
  channel_id INTEGER,
  channel_alias TEXT,
  current_track_id INTEGER,
  current_spotify_id TEXT,
  queue_id INTEGER,
  queue_start_time INTEGER,
  comment_velocity INTEGER,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_sh_host_station_session_time
ON sh_host_station_snapshots(session_id, observed_at);

CREATE TABLE IF NOT EXISTS sh_host_queue_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  station_id INTEGER,
  queue_id INTEGER,
  queue_start_time INTEGER,
  is_paused INTEGER,
  queue_hash TEXT,
  current_track_id INTEGER,
  current_spotify_id TEXT,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_sh_host_queue_session_time
ON sh_host_queue_snapshots(session_id, observed_at);

CREATE TABLE IF NOT EXISTS sh_host_queue_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  station_id INTEGER,
  queue_id INTEGER,
  queue_start_time INTEGER,
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
  raw_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sh_host_queue_position
ON sh_host_queue_items(session_id, queue_start_time, position);

CREATE INDEX IF NOT EXISTS idx_sh_host_queue_items_session
ON sh_host_queue_items(session_id, queue_start_time, position);

CREATE TABLE IF NOT EXISTS sh_host_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  comment_id INTEGER NOT NULL,
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
  followers INTEGER,
  following INTEGER,
  active_stream_days INTEGER,
  emoji TEXT,
  raw_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sh_host_comment
ON sh_host_comments(session_id, comment_id);

CREATE INDEX IF NOT EXISTS idx_sh_host_comments_session_time
ON sh_host_comments(session_id, chat_time_ms, observed_at);

CREATE TABLE IF NOT EXISTS sh_host_raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  station_id INTEGER,
  channel TEXT,
  event TEXT,
  data_json TEXT,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_sh_host_events_session_time
ON sh_host_raw_events(session_id, observed_at);
