-- Hot paths for unchanged-queue detection and dashboard queue revision checks.
-- Safe to run repeatedly.

CREATE INDEX IF NOT EXISTS idx_sh_queue_snapshots_station_start_observed
ON sh_queue_snapshots(station_id, start_time, observed_at DESC);
