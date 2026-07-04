CREATE TABLE IF NOT EXISTS sh_snapshot_current (
  channel_key TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  last_snapshot_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sh_queue_current (
  station_id INTEGER PRIMARY KEY,
  queue_id INTEGER,
  start_time INTEGER,
  structural_hash TEXT NOT NULL,
  is_paused INTEGER,
  observed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

DROP TABLE IF EXISTS sh_queue_current_repair;
CREATE TABLE sh_queue_current_repair (
  station_id INTEGER PRIMARY KEY,
  queue_id INTEGER,
  start_time INTEGER,
  structural_hash TEXT NOT NULL,
  likes_hash TEXT,
  is_paused INTEGER,
  observed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO sh_queue_current_repair(
  station_id,queue_id,start_time,structural_hash,likes_hash,
  is_paused,observed_at,updated_at
)
SELECT station_id,queue_id,start_time,structural_hash,NULL,
       is_paused,observed_at,updated_at
FROM sh_queue_current;
DROP TABLE sh_queue_current;
ALTER TABLE sh_queue_current_repair RENAME TO sh_queue_current;

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
  PRIMARY KEY(station_id,track_key)
);

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
  PRIMARY KEY(station_id,bucket_start)
);
CREATE TABLE IF NOT EXISTS sh_comment_daily_counts (
  station_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  comment_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(station_id,day_key)
);

CREATE INDEX IF NOT EXISTS idx_sh_track_like_current_observed ON sh_track_like_current(station_id,observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_queue_items_station_start_position ON sh_queue_items(station_id,start_time,position);
CREATE INDEX IF NOT EXISTS idx_sh_queue_items_station_start_spotify ON sh_queue_items(station_id,start_time,spotify_id);
CREATE INDEX IF NOT EXISTS idx_sh_track_metadata_spotify_fetched ON sh_track_metadata(spotify_id,fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_channel_snapshots_latest ON sh_channel_snapshots(observed_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_sh_queue_snapshots_station_latest ON sh_queue_snapshots(station_id,observed_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_sh_track_like_observations_station_key_latest ON sh_track_like_observations(station_id,track_key,observed_at DESC,id DESC);
