-- Gap reconstruction needs one boundary row per active channel. Keep this a
-- channel-local seek instead of ranking the complete retained snapshot history.
CREATE INDEX IF NOT EXISTS idx_sh_channel_snapshots_channel_time_id
ON sh_channel_snapshots(channel_id, observed_at DESC, id DESC);

ANALYZE sh_channel_snapshots;
