CREATE TABLE IF NOT EXISTS sh_channel_rankings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ranking_date TEXT NOT NULL,
  observed_at INTEGER,
  ranking_type TEXT NOT NULL,
  rank INTEGER,
  channel_name TEXT,
  channel_alias TEXT,
  listener_count REAL,
  member_count INTEGER,
  total_listens INTEGER,
  source_sheet TEXT,
  source_row INTEGER,
  quality_score REAL NOT NULL DEFAULT 1,
  quality_flags TEXT,
  raw_json TEXT,
  imported_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_ranking
ON sh_channel_rankings (ranking_date, ranking_type, rank, channel_name);

CREATE INDEX IF NOT EXISTS idx_channel_rankings_date
ON sh_channel_rankings (ranking_date);

CREATE INDEX IF NOT EXISTS idx_channel_rankings_channel
ON sh_channel_rankings (channel_name, ranking_date);

CREATE INDEX IF NOT EXISTS idx_channel_rankings_type_date
ON sh_channel_rankings (ranking_type, ranking_date);
