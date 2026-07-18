CREATE TABLE IF NOT EXISTS sh_queue_materialization_state (
  station_id INTEGER PRIMARY KEY,
  queue_id INTEGER,
  start_time INTEGER,
  source_structural_hash TEXT NOT NULL,
  source_likes_hash TEXT,
  total_track_count INTEGER NOT NULL,
  materialized_count INTEGER NOT NULL,
  requested_count INTEGER NOT NULL,
  last_position INTEGER,
  observed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sh_queue_materialization_updated
  ON sh_queue_materialization_state(updated_at DESC);
