CREATE TABLE IF NOT EXISTS sh_track_like_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at INTEGER NOT NULL,
  track_title TEXT NOT NULL,
  artist TEXT,
  like_count INTEGER NOT NULL,
  source_sheet_id TEXT NOT NULL,
  source_gid TEXT NOT NULL,
  source_row INTEGER,
  raw_json TEXT,
  UNIQUE(source_sheet_id, source_gid, source_row)
);

CREATE INDEX IF NOT EXISTS idx_track_like_history_time
  ON sh_track_like_history(observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_track_like_history_track_time
  ON sh_track_like_history(track_title, artist, observed_at DESC);
