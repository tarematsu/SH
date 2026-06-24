CREATE TABLE IF NOT EXISTS sh_email_stream_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL UNIQUE,
  week_of TEXT NOT NULL,
  email_sent_at INTEGER NOT NULL,
  effective_at INTEGER NOT NULL,
  stream_count INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'stationhead_email_recap',
  validation_status TEXT NOT NULL,
  timing_basis TEXT NOT NULL DEFAULT 'email_sent_minus_57m',
  timing_offset_minutes INTEGER NOT NULL DEFAULT 57,
  reference_source TEXT,
  estimated_stream_count INTEGER,
  difference INTEGER,
  relative_difference REAL,
  nearest_distance_minutes REAL,
  validation_notes TEXT,
  imported_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sh_email_stream_snapshots_effective
ON sh_email_stream_snapshots(effective_at);

CREATE INDEX IF NOT EXISTS idx_sh_email_stream_snapshots_sent
ON sh_email_stream_snapshots(email_sent_at);
