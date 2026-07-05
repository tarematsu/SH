CREATE TABLE IF NOT EXISTS sh_data_maintenance_state (
  id TEXT PRIMARY KEY,
  last_rollup_key TEXT,
  last_cleanup_at INTEGER NOT NULL DEFAULT 0,
  legacy_backfill_id INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
