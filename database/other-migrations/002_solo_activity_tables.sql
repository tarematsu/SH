-- sh_host_comments-derived rollups used by site's solo-activity-counts.js,
-- part of the same host-monitoring domain as the sh_host_* tables in
-- 001_initial_schema.sql.

CREATE TABLE IF NOT EXISTS sh_solo_activity_state (
  session_id INTEGER PRIMARY KEY,
  station_id INTEGER,
  last_item_id INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  last_observed_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sh_solo_activity_minutes (
  session_id INTEGER NOT NULL,
  bucket_start INTEGER NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(session_id,bucket_start)
);

CREATE TABLE IF NOT EXISTS sh_solo_activity_days (
  session_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(session_id,day_key)
);
