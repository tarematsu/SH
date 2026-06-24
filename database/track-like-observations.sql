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

CREATE INDEX IF NOT EXISTS idx_track_like_observations_track_time
  ON sh_track_like_observations(track_key, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_track_like_observations_time
  ON sh_track_like_observations(observed_at DESC);
