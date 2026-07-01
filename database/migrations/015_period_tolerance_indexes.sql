-- Direct range scans for period boundary evidence across all channels.
CREATE INDEX IF NOT EXISTS idx_sh_channel_snapshots_observed_at_id
  ON sh_channel_snapshots(observed_at, id);
