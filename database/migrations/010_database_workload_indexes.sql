-- D1 query indexes
CREATE INDEX IF NOT EXISTS idx_sh_channel_snapshots_channel_time_id ON sh_channel_snapshots(channel_id, observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sh_comments_station_effective_time ON sh_comments(station_id, COALESCE(chat_time_ms, chat_time * 1000, observed_at));
CREATE INDEX IF NOT EXISTS idx_sh_track_like_observations_station_track_time ON sh_track_like_observations(station_id, track_key, observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sh_host_station_snapshots_session_time_id ON sh_host_station_snapshots(session_id, observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sh_host_comments_session_effective_time ON sh_host_comments(session_id, COALESCE(chat_time_ms, chat_time * 1000, observed_at));
CREATE INDEX IF NOT EXISTS idx_sh_host_queue_items_session_identity ON sh_host_queue_items(session_id, stationhead_track_id, spotify_id, queue_track_id);
CREATE INDEX IF NOT EXISTS idx_sh_legacy_snapshots_host_time_source ON sh_legacy_snapshots(host_handle, observed_at, source_note);
CREATE INDEX IF NOT EXISTS idx_sh_channel_rankings_date_name_rank ON sh_channel_rankings(ranking_date, channel_name, rank);
