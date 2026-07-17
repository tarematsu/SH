-- Schema for the OTHER_DB database (stationhead-other), which holds tables
-- exclusive to sh-monitor-other and site that have no write dependency on
-- the sh-buddies collection pipeline tables. Applied by
-- worker/scripts/provision-other-db.mjs, mirroring how
-- database/facts-migrations/001_initial_schema.sql provisions MINUTE_DB.

CREATE TABLE IF NOT EXISTS sh_cloud_host_monitor_state (
  id TEXT PRIMARY KEY,
  session_id INTEGER,
  station_id INTEGER,
  phase TEXT NOT NULL DEFAULT 'idle',
  candidate_count INTEGER NOT NULL DEFAULT 0,
  inactive_count INTEGER NOT NULL DEFAULT 0,
  last_profile_at INTEGER,
  last_queue_hash TEXT,
  last_success_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sh_cloud_host_monitor_updated
ON sh_cloud_host_monitor_state(updated_at DESC);

CREATE TABLE IF NOT EXISTS sh_official_news_monitor_state (
  id TEXT PRIMARY KEY,
  latest_item_id TEXT,
  latest_published_at INTEGER,
  updated_at INTEGER NOT NULL
);
