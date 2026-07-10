CREATE TABLE IF NOT EXISTS sh_email_stream_snapshots (
  source_key TEXT PRIMARY KEY,
  week_of TEXT NOT NULL,
  email_sent_at INTEGER NOT NULL,
  effective_at INTEGER NOT NULL,
  stream_count INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'stationhead_email_recap',
  validation_status TEXT NOT NULL,
  timing_basis TEXT NOT NULL,
  timing_offset_minutes INTEGER NOT NULL,
  reference_source TEXT,
  estimated_stream_count INTEGER,
  difference INTEGER,
  relative_difference REAL,
  nearest_distance_minutes REAL,
  validation_notes TEXT,
  imported_at INTEGER NOT NULL
);
