-- Indexes for UTC track-history evidence lookup and queue reachability joins.
-- Safe to run repeatedly.

CREATE INDEX IF NOT EXISTS idx_sh_queue_snapshots_track_history_evidence
ON sh_queue_snapshots(observed_at, start_time, station_id, is_paused);

CREATE INDEX IF NOT EXISTS idx_sh_queue_snapshots_station_start
ON sh_queue_snapshots(station_id, start_time);

CREATE INDEX IF NOT EXISTS idx_sh_queue_items_track_history_evidence
ON sh_queue_items(observed_at, start_time, station_id);
