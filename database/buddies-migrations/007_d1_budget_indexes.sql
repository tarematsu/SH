CREATE INDEX IF NOT EXISTS idx_sh_channel_snapshots_observed_id
ON sh_channel_snapshots(observed_at, id);

CREATE INDEX IF NOT EXISTS idx_sh_queue_items_start_station
ON sh_queue_items(start_time, station_id);

CREATE INDEX IF NOT EXISTS idx_sh_queue_snapshots_station_observed
ON sh_queue_snapshots(station_id, observed_at DESC, id DESC);
