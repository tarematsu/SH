-- Performance optimizations. Safe to run repeatedly.

CREATE INDEX IF NOT EXISTS idx_sh_channel_snapshots_observed
ON sh_channel_snapshots(observed_at);

CREATE INDEX IF NOT EXISTS idx_sh_channel_snapshots_station_observed
ON sh_channel_snapshots(station_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_sh_channel_snapshots_host_account_observed
ON sh_channel_snapshots(host_account_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_sh_channel_snapshots_host_handle_observed
ON sh_channel_snapshots(host_handle, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_sh_queue_snapshots_observed
ON sh_queue_snapshots(observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_sh_queue_snapshots_station_observed
ON sh_queue_snapshots(station_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_sh_queue_items_station_start_position
ON sh_queue_items(station_id, start_time, position);

CREATE INDEX IF NOT EXISTS idx_sh_legacy_host_time
ON sh_legacy_snapshots(host_handle, observed_at);

CREATE INDEX IF NOT EXISTS idx_sh_legacy_host_event_time
ON sh_legacy_snapshots(host_handle, source_note, observed_at);

CREATE INDEX IF NOT EXISTS idx_sh_host_sessions_handle_started
ON sh_host_broadcast_sessions(handle, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_sh_host_station_session_time
ON sh_host_station_snapshots(session_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_sh_host_comments_session_time
ON sh_host_comments(session_id, chat_time_ms, observed_at);

CREATE TABLE IF NOT EXISTS sh_official_broadcast_summary (
  host_handle TEXT NOT NULL,
  event_name TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  started_jst TEXT,
  ended_jst TEXT,
  sample_count INTEGER NOT NULL DEFAULT 0,
  listener_avg REAL,
  listener_max INTEGER,
  likes_max INTEGER,
  distinct_tracks INTEGER,
  refreshed_at INTEGER NOT NULL,
  PRIMARY KEY(host_handle, event_name)
);

CREATE INDEX IF NOT EXISTS idx_sh_official_summary_started
ON sh_official_broadcast_summary(host_handle, started_at);

INSERT OR REPLACE INTO sh_official_broadcast_summary (
  host_handle,event_name,started_at,ended_at,started_jst,ended_jst,
  sample_count,listener_avg,listener_max,likes_max,distinct_tracks,refreshed_at
)
SELECT
  host_handle,
  source_note,
  MIN(observed_at),
  MAX(observed_at),
  MIN(observed_jst),
  MAX(observed_jst),
  COUNT(*),
  ROUND(AVG(listener_count),1),
  MAX(listener_count),
  MAX(likes),
  COUNT(DISTINCT CASE WHEN track_title IS NOT NULL AND track_title<>'' THEN track_title END),
  unixepoch('now') * 1000
FROM sh_legacy_snapshots
WHERE host_handle='sakurazaka46jp' AND source_note IS NOT NULL
GROUP BY host_handle,source_note;

CREATE TABLE IF NOT EXISTS sh_comment_velocity_samples (
  source_scope TEXT NOT NULL,
  station_id INTEGER NOT NULL,
  session_id INTEGER NOT NULL DEFAULT 0,
  observed_at INTEGER NOT NULL,
  comment_velocity INTEGER NOT NULL DEFAULT 0,
  latest_comment_id INTEGER,
  PRIMARY KEY(source_scope, station_id, session_id, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_sh_comment_velocity_lookup
ON sh_comment_velocity_samples(source_scope, station_id, session_id, observed_at DESC);
