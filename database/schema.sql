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
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sh_sh_channel_snapshots_time ON sh_channel_snapshots(observed_at DESC);

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
CREATE INDEX IF NOT EXISTS idx_sh_sh_queue_items_isrc ON sh_queue_items(isrc);

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
