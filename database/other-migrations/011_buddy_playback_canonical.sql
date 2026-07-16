-- buddy46 playback is fully owned by OTHER_DB. Keep its pause clock and
-- metadata cache beside the current playback row so Pages never needs another
-- database to build /api/playback?channel=buddy46.

CREATE TABLE IF NOT EXISTS sh_buddy_playback_clock (
  channel_alias TEXT PRIMARY KEY,
  queue_id INTEGER,
  start_time INTEGER,
  is_paused INTEGER NOT NULL DEFAULT 0,
  paused_total_ms INTEGER NOT NULL DEFAULT 0,
  pause_started_at INTEGER,
  observed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sh_buddy_track_metadata (
  spotify_id TEXT PRIMARY KEY,
  isrc TEXT,
  title TEXT,
  artist TEXT,
  display_title TEXT,
  thumbnail_url TEXT,
  spotify_url TEXT,
  source TEXT,
  fetched_at INTEGER NOT NULL,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_sh_buddy_track_metadata_isrc
  ON sh_buddy_track_metadata(isrc, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_buddy_track_metadata_fetched
  ON sh_buddy_track_metadata(fetched_at DESC, spotify_id);
