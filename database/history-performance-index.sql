CREATE INDEX IF NOT EXISTS idx_sh_legacy_observed_cursor
ON sh_legacy_snapshots(observed_at, id);
