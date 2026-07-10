
CREATE INDEX IF NOT EXISTS idx_sh_channel_snapshots_station_observed
ON sh_channel_snapshots(station_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_sh_channel_snapshots_host_account_observed
ON sh_channel_snapshots(host_account_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_sh_channel_snapshots_host_handle_observed
ON sh_channel_snapshots(host_handle, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_sh_queue_snapshots_station_observed
ON sh_queue_snapshots(station_id, observed_at DESC);
