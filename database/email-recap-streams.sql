CREATE TABLE IF NOT EXISTS sh_email_stream_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL UNIQUE,
  week_of TEXT NOT NULL,
  email_sent_at INTEGER NOT NULL,
  stream_count INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'stationhead_email_recap',
  validation_status TEXT NOT NULL,
  reference_source TEXT,
  reference_observed_at INTEGER,
  reference_stream_count INTEGER,
  estimated_stream_count INTEGER,
  difference INTEGER,
  relative_difference REAL,
  time_distance_minutes REAL,
  imported_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sh_email_stream_snapshots_time
ON sh_email_stream_snapshots(email_sent_at);
