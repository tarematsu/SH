CREATE TABLE IF NOT EXISTS sh_leaderboard_fetches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ranking_date TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_hash TEXT,
  row_count INTEGER,
  status TEXT NOT NULL,
  raw_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sh_leaderboard_fetches_week_source
ON sh_leaderboard_fetches (ranking_date, source);

CREATE INDEX IF NOT EXISTS idx_sh_leaderboard_fetches_fetched_at
ON sh_leaderboard_fetches (fetched_at);
