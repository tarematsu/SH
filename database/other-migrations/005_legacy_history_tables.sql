-- Durable read-only history retained from the archived monitor database.
-- Live collection and minute facts do not write these tables.

CREATE TABLE IF NOT EXISTS sh_legacy_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_key TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL,
  source_row INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  observed_jst TEXT NOT NULL,
  listener_count INTEGER,
  track_title TEXT,
  artist_name TEXT,
  likes INTEGER,
  comment_velocity REAL,
  host_handle TEXT,
  total_member_count INTEGER,
  source_note TEXT,
  quality_score REAL NOT NULL,
  quality_flags TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  imported_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_other_legacy_snapshots_time
  ON sh_legacy_snapshots(observed_at, id);
CREATE INDEX IF NOT EXISTS idx_other_legacy_snapshots_host_time
  ON sh_legacy_snapshots(host_handle, observed_at);

CREATE TABLE IF NOT EXISTS sh_channel_rankings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ranking_date TEXT NOT NULL,
  observed_at INTEGER,
  ranking_type TEXT NOT NULL,
  rank INTEGER,
  channel_name TEXT,
  channel_alias TEXT,
  listener_count INTEGER,
  member_count INTEGER,
  total_listens INTEGER,
  source_sheet TEXT,
  source_row INTEGER,
  quality_score REAL NOT NULL DEFAULT 1,
  quality_flags TEXT,
  raw_json TEXT,
  imported_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_other_channel_rankings_date
  ON sh_channel_rankings(ranking_date, rank);
