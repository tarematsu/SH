-- Repair the source-shaped queue views used by track-history readers.
--
-- Migration 010 exposed every complete queue revision as a full queue snapshot.
-- A single queue instance with N structural revisions therefore appeared N times
-- to the legacy track-history SQL.  The old BUDDIES table represented only the
-- current rows for one queue instance, so restore that one-snapshot contract.
--
-- The previous sh_queue_snapshots view also hard-coded is_paused=0.  Rebuild it
-- from minute facts so paused wall-clock time is not counted as playback time.

DROP VIEW IF EXISTS sh_queue_items;
DROP VIEW IF EXISTS sh_queue_snapshots;

CREATE VIEW sh_queue_items AS
WITH ranked_revisions AS (
  SELECT r.*,
    ROW_NUMBER() OVER (
      PARTITION BY r.channel_id,COALESCE(r.station_id,-1),r.queue_start_time
      ORDER BY r.effective_at DESC,r.id DESC
    ) AS revision_rank
  FROM sh_queue_revisions r
  WHERE r.status='complete'
    AND r.queue_start_time IS NOT NULL
)
SELECT CAST(r.id*1000000+i.position AS INTEGER) AS id,
  r.effective_at AS observed_at,
  r.station_id,
  r.queue_id,
  r.queue_start_time AS start_time,
  i.position,
  i.queue_track_id,
  i.stationhead_track_id,
  i.spotify_id,
  NULL AS apple_music_id,
  i.deezer_id,
  i.isrc,
  i.duration_ms,
  NULL AS preview_url,
  COALESCE((
    SELECT cc.count_value
    FROM sh_track_counter_changes cc
    WHERE cc.occurrence_key='revision:'||CAST(r.id AS TEXT)||':'||CAST(i.position AS TEXT)
    ORDER BY cc.observed_at DESC,cc.id DESC
    LIMIT 1
  ),i.bite_count) AS bite_count,
  NULL AS raw_json
FROM ranked_revisions r
JOIN sh_queue_revision_items i ON i.revision_id=r.id
WHERE r.revision_rank=1;

CREATE VIEW sh_queue_snapshots AS
SELECT f.id,
  f.observed_at,
  c.station_id,
  c.queue_id,
  c.queue_start_time AS start_time,
  COALESCE(f.is_paused,0) AS is_paused,
  NULL AS raw_json
FROM sh_minute_facts f
JOIN sh_minute_fact_context c ON c.fact_id=f.id
WHERE COALESCE(c.queue_available,0)=1
  AND c.queue_start_time IS NOT NULL;

PRAGMA optimize;
