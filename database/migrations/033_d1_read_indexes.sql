CREATE INDEX IF NOT EXISTS idx_sh_queue_items_station_start_position ON sh_queue_items(station_id,start_time,position);
CREATE INDEX IF NOT EXISTS idx_sh_queue_items_station_start_spotify ON sh_queue_items(station_id,start_time,spotify_id);
CREATE INDEX IF NOT EXISTS idx_sh_track_metadata_spotify_fetched ON sh_track_metadata(spotify_id,fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_channel_snapshots_latest ON sh_channel_snapshots(observed_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_sh_queue_snapshots_station_latest ON sh_queue_snapshots(station_id,observed_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_sh_track_like_observations_station_key_latest ON sh_track_like_observations(station_id,track_key,observed_at DESC,id DESC);
