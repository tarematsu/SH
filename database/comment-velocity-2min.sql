
CREATE INDEX IF NOT EXISTS idx_sh_comments_station_posted
ON sh_comments(station_id, chat_time_ms, chat_time, observed_at);

CREATE INDEX IF NOT EXISTS idx_sh_host_comments_velocity
ON sh_host_comments(session_id, chat_time_ms, chat_time, observed_at);
