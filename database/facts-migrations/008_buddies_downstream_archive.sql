-- Durable downstream archive for the compact 30-day BUDDIES recovery buffer.
-- The minute worker advances these cursors only after the corresponding FACTS
-- writes succeed. Raw JSON stays in BUDDIES for recovery, while FACTS keeps
-- compact, queryable history indefinitely.

CREATE TABLE IF NOT EXISTS sh_buddies_sync_state (
  sync_key TEXT PRIMARY KEY,
  cursor_observed_at INTEGER NOT NULL DEFAULT 0,
  cursor_source_id INTEGER NOT NULL DEFAULT 0,
  cursor_source_text TEXT,
  rows_processed INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO sh_buddies_sync_state(sync_key,updated_at)
VALUES
  ('queue-items',unixepoch('now')*1000),
  ('track-likes',unixepoch('now')*1000),
  ('track-metadata',unixepoch('now')*1000);

CREATE TABLE IF NOT EXISTS sh_queue_item_observations (
  source_id INTEGER PRIMARY KEY,
  observed_at INTEGER NOT NULL,
  station_id INTEGER,
  queue_id INTEGER,
  start_time INTEGER,
  position INTEGER NOT NULL,
  queue_track_id INTEGER,
  stationhead_track_id INTEGER,
  spotify_id TEXT,
  apple_music_id TEXT,
  deezer_id TEXT,
  isrc TEXT,
  duration_ms INTEGER,
  preview_url TEXT,
  bite_count INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sh_queue_item_observations_station_start
  ON sh_queue_item_observations(station_id,start_time,position);
CREATE INDEX IF NOT EXISTS idx_sh_queue_item_observations_time
  ON sh_queue_item_observations(observed_at DESC,source_id DESC);

CREATE TABLE IF NOT EXISTS sh_track_like_observations (
  source_id INTEGER PRIMARY KEY,
  observed_at INTEGER NOT NULL,
  station_id INTEGER,
  queue_id INTEGER,
  start_time INTEGER,
  position INTEGER,
  queue_track_id INTEGER,
  stationhead_track_id INTEGER,
  spotify_id TEXT,
  apple_music_id TEXT,
  isrc TEXT,
  track_key TEXT NOT NULL,
  like_count INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'buddies-buffer'
);
-- The source-shaped like name may be a compatibility view after the facts
-- counter-log cutover, so its physical indexes are owned by the source DB and
-- the canonical counter tables instead of this replayed migration.

CREATE TABLE IF NOT EXISTS sh_track_metadata (
  spotify_id TEXT PRIMARY KEY,
  title TEXT,
  artist TEXT,
  display_title TEXT,
  thumbnail_url TEXT,
  spotify_url TEXT,
  source TEXT NOT NULL DEFAULT 'buddies-buffer',
  fetched_at INTEGER NOT NULL,
  raw_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_sh_track_metadata_fetched_at
  ON sh_track_metadata(fetched_at DESC);

-- Compatibility read models for history/queue code. They expose compact FACTS
-- data using the old source-shaped names; no BUDDIES raw JSON is copied.
DROP VIEW IF EXISTS sh_queue_items;
DROP VIEW IF EXISTS sh_track_metadata_view;
DROP VIEW IF EXISTS sh_queue_snapshots;
DROP VIEW IF EXISTS sh_channel_snapshots;
DROP VIEW IF EXISTS sh_queue_current;
DROP VIEW IF EXISTS sh_track_like_current;

CREATE VIEW IF NOT EXISTS sh_queue_items AS
SELECT source_id AS id,observed_at,station_id,queue_id,start_time,position,
  queue_track_id,stationhead_track_id,spotify_id,apple_music_id,deezer_id,isrc,
  duration_ms,preview_url,bite_count,NULL AS raw_json
FROM sh_queue_item_observations;

CREATE VIEW IF NOT EXISTS sh_track_metadata_view AS
SELECT spotify_id,title,artist,display_title,thumbnail_url,spotify_url,fetched_at,raw_json
FROM sh_track_metadata;

CREATE VIEW IF NOT EXISTS sh_queue_snapshots AS
SELECT r.id,r.effective_at AS observed_at,r.station_id,r.queue_id,
  r.queue_start_time AS start_time,0 AS is_paused,NULL AS raw_json
FROM sh_queue_revisions r;

CREATE VIEW IF NOT EXISTS sh_channel_snapshots AS
SELECT f.id,f.observed_at,f.channel_id,NULL AS channel_alias,NULL AS channel_name,
  c.station_id,f.is_broadcasting AS is_launched,f.is_broadcasting,
  NULL AS chat_status,f.listener_count,f.online_member_count,
  NULL AS total_member_count,f.guest_count,f.reported_total_listens AS total_listens,
  NULL AS stream_goal,f.reported_current_stream_count AS current_stream_count,
  h.stationhead_account_id AS host_account_id,h.current_handle AS host_handle,
  c.broadcast_start_time,NULL AS raw_json,f.comment_count AS comment_velocity,
  NULL AS validated_stream_count
FROM sh_minute_facts f
LEFT JOIN sh_minute_fact_context c ON c.fact_id=f.id
LEFT JOIN sh_hosts h ON h.id=c.host_id;

CREATE VIEW IF NOT EXISTS sh_queue_current AS
SELECT station_id,queue_id,start_time,is_paused,observed_at,
  NULL AS structural_hash,NULL AS likes_hash
FROM sh_queue_read_model_current;

CREATE VIEW IF NOT EXISTS sh_track_like_current AS
WITH ranked AS (
  SELECT o.*,
    ROW_NUMBER() OVER (
      PARTITION BY o.station_id,o.track_key
      ORDER BY o.observed_at DESC,o.source_id DESC
    ) AS row_rank
  FROM sh_track_like_observations o
)
SELECT station_id,track_key,queue_id,start_time,position,queue_track_id,
  stationhead_track_id,spotify_id,apple_music_id,isrc,like_count,observed_at
FROM ranked WHERE row_rank=1;
