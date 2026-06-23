PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at TEXT NOT NULL,
  channel_slug TEXT NOT NULL,
  status TEXT,
  play_count INTEGER,
  comment_count INTEGER,
  source TEXT NOT NULL DEFAULT 'scraper',
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_unique
ON snapshots(channel_slug, observed_at, source);

CREATE INDEX IF NOT EXISTS idx_snapshots_time
ON snapshots(observed_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_slug TEXT NOT NULL,
  comment_key TEXT NOT NULL UNIQUE,
  observed_at TEXT NOT NULL,
  author_name TEXT,
  comment_text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'scraper',
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_comments_time
ON comments(observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_comments_author
ON comments(author_name);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  snapshot_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  source TEXT NOT NULL DEFAULT 'scraper'
);