CREATE TABLE IF NOT EXISTS sh_history_import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  imported_at INTEGER NOT NULL,
  source_count INTEGER NOT NULL,
  source_rows INTEGER NOT NULL,
  accepted_rows INTEGER NOT NULL,
  skipped_rows INTEGER NOT NULL,
  duplicate_rows INTEGER NOT NULL,
  warning_rows INTEGER NOT NULL,
  report_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sh_legacy_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_key TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL,
  source_row INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  observed_jst TEXT NOT NULL,
  listener_count INTEGER,
  total_stream_count INTEGER,
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

CREATE INDEX IF NOT EXISTS idx_sh_legacy_observed_at ON sh_legacy_snapshots(observed_at);
CREATE INDEX IF NOT EXISTS idx_sh_legacy_quality ON sh_legacy_snapshots(quality_score);

CREATE TABLE IF NOT EXISTS sh_daily_summary (
  period_key TEXT PRIMARY KEY,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  reliable_sample_count INTEGER NOT NULL,
  listener_avg REAL,
  listener_min INTEGER,
  listener_max INTEGER,
  stream_start INTEGER,
  stream_end INTEGER,
  stream_growth INTEGER,
  member_start INTEGER,
  member_end INTEGER,
  member_growth INTEGER,
  likes_max INTEGER,
  distinct_tracks INTEGER,
  primary_host TEXT,
  quality_score REAL NOT NULL,
  quality_flags TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sh_weekly_summary AS SELECT * FROM sh_daily_summary WHERE 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sh_weekly_key ON sh_weekly_summary(period_key);
CREATE TABLE IF NOT EXISTS sh_monthly_summary AS SELECT * FROM sh_daily_summary WHERE 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sh_monthly_key ON sh_monthly_summary(period_key);
