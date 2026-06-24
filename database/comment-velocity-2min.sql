-- comment_velocity columns are part of the current base schemas:
--   database/schema.sql
--   database/host-monitoring.sql
--
-- Older databases that predate those schemas must add the columns manually once.
-- Re-running ALTER TABLE ADD COLUMN is not portable in SQLite/D1, so this
-- compatibility file now contains only idempotent indexes.

CREATE INDEX IF NOT EXISTS idx_sh_comments_station_posted
ON sh_comments(station_id, chat_time_ms, chat_time, observed_at);

CREATE INDEX IF NOT EXISTS idx_sh_host_comments_velocity
ON sh_host_comments(session_id, chat_time_ms, chat_time, observed_at);
