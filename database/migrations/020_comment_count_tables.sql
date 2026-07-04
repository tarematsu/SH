CREATE TABLE IF NOT EXISTS sh_comment_counter_state (
  station_id INTEGER PRIMARY KEY,
  last_comment_id INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  last_observed_at INTEGER NOT NULL DEFAULT 0,
  last_cleanup_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sh_comment_minute_counts (
  station_id INTEGER NOT NULL,
  bucket_start INTEGER NOT NULL,
  comment_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (station_id, bucket_start)
);

CREATE TABLE IF NOT EXISTS sh_comment_daily_counts (
  station_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  comment_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (station_id, day_key)
);

CREATE INDEX IF NOT EXISTS idx_sh_comment_minute_counts_time
  ON sh_comment_minute_counts(bucket_start DESC, station_id);
CREATE INDEX IF NOT EXISTS idx_sh_ingest_claims_payload_recent
  ON sh_ingest_claims(data_type,payload_hash,observed_at DESC,source_priority DESC);
