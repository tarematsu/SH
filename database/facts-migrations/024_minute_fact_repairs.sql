-- Durable, row-level ledger for source-verified historical minute-fact repairs.
-- The ledger intentionally has no foreign key so the original fingerprint
-- survives a fact replacement or a manual recovery operation.
CREATE TABLE IF NOT EXISTS sh_minute_fact_repairs (
  repair_key TEXT NOT NULL,
  fact_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  minute_at INTEGER NOT NULL,
  source_snapshot_id INTEGER,
  source_snapshot_observed_at INTEGER,
  expected_current_stream_count INTEGER,
  expected_total_listens INTEGER,
  original_source_priority INTEGER,
  original_source_record_id TEXT,
  original_reported_current_stream_count INTEGER,
  original_reported_total_listens INTEGER,
  expected_source_record_id TEXT,
  status TEXT NOT NULL DEFAULT 'detected',
  last_error TEXT,
  detected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(repair_key, fact_id)
);

CREATE INDEX IF NOT EXISTS idx_sh_minute_fact_repairs_status
  ON sh_minute_fact_repairs(repair_key,status,updated_at,fact_id);
