CREATE TABLE IF NOT EXISTS sh_ingest_claims (
  dedupe_key TEXT PRIMARY KEY,
  data_type TEXT NOT NULL,
  collector_id TEXT NOT NULL,
  collector_kind TEXT NOT NULL,
  source_priority INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sh_ingest_claims_type_time
ON sh_ingest_claims(data_type, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_sh_ingest_claims_collector_time
ON sh_ingest_claims(collector_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS sh_ingest_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL,
  data_type TEXT NOT NULL,
  canonical_collector_id TEXT,
  canonical_priority INTEGER,
  canonical_hash TEXT,
  incoming_collector_id TEXT NOT NULL,
  incoming_priority INTEGER NOT NULL,
  incoming_hash TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  detected_at INTEGER NOT NULL,
  resolution TEXT NOT NULL,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_sh_ingest_conflicts_key_time
ON sh_ingest_conflicts(dedupe_key, detected_at DESC);
