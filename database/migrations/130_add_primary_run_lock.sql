CREATE TABLE IF NOT EXISTS sh_primary_run_lock (
  scope TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL
);
