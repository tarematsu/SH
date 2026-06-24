-- 直近2分（120秒）のユニークコメント数を各1分スナップショットへ保存するための列追加
ALTER TABLE sh_channel_snapshots ADD COLUMN comment_velocity INTEGER;
ALTER TABLE sh_host_station_snapshots ADD COLUMN comment_velocity INTEGER;

CREATE INDEX IF NOT EXISTS idx_sh_comments_station_posted
ON sh_comments(station_id, chat_time_ms, chat_time, observed_at);

CREATE INDEX IF NOT EXISTS idx_sh_host_comments_velocity
ON sh_host_comments(session_id, chat_time_ms, chat_time, observed_at);
