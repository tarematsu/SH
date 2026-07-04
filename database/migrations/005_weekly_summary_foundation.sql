-- Foundation required by 006_email_weekly_summary.sql and 016_email_stream_runtime.sql.
-- Production databases may already contain this table, so keep the migration idempotent.
CREATE TABLE IF NOT EXISTS sh_weekly_summary (
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
