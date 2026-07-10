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

DROP INDEX IF EXISTS uq_channel_ranking;
DROP INDEX IF EXISTS uq_channel_ranking_channel;

DELETE FROM sh_channel_rankings
WHERE id NOT IN (
  SELECT MAX(id)
  FROM sh_channel_rankings
  GROUP BY ranking_date, ranking_type, channel_name
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_ranking_channel
ON sh_channel_rankings (ranking_date, ranking_type, channel_name);

CREATE INDEX IF NOT EXISTS idx_channel_rankings_date_rank
ON sh_channel_rankings (ranking_date DESC, rank ASC);

CREATE INDEX IF NOT EXISTS idx_channel_rankings_channel_date
ON sh_channel_rankings (channel_name, ranking_date);

CREATE INDEX IF NOT EXISTS idx_channel_rankings_type_date
ON sh_channel_rankings (ranking_type, ranking_date DESC);
