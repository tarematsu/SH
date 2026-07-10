CREATE INDEX IF NOT EXISTS idx_sh_legacy_snapshots_observed_at_id
  ON sh_legacy_snapshots(observed_at, id);
