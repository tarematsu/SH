-- Track-history reconstruction runs against the compact FACTS database rather
-- than the raw BUDDIES operational archive. Keep the source-shaped compatibility
-- views, but make their access paths seek bounded queue instances directly.

CREATE INDEX IF NOT EXISTS idx_sh_queue_revisions_track_history_latest
ON sh_queue_revisions(
  queue_start_time,
  channel_id,
  COALESCE(station_id,-1),
  effective_at DESC,
  id DESC
)
WHERE status='complete' AND queue_start_time IS NOT NULL;

DROP VIEW IF EXISTS sh_queue_items;
CREATE VIEW sh_queue_items AS
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
FROM sh_queue_revisions r
JOIN sh_queue_revision_items i ON i.revision_id=r.id
WHERE r.status='complete'
  AND r.queue_start_time IS NOT NULL
  AND r.id=(
    SELECT latest.id
    FROM sh_queue_revisions latest
    WHERE latest.status='complete'
      AND latest.queue_start_time=r.queue_start_time
      AND latest.channel_id=r.channel_id
      AND COALESCE(latest.station_id,-1)=COALESCE(r.station_id,-1)
    ORDER BY latest.effective_at DESC,latest.id DESC
    LIMIT 1
  );

-- Resolve only the fields needed by playback reconstruction. The previous view
-- expanded the general-purpose sh_minute_fact_context compatibility view, which
-- also joined queue items and performed a counter lookup for every minute row.
DROP VIEW IF EXISTS sh_queue_snapshots;
CREATE VIEW sh_queue_snapshots AS
SELECT f.id,
  f.observed_at,
  COALESCE(v.station_id_override,s.station_id,r.station_id) AS station_id,
  r.queue_id,
  r.queue_start_time AS start_time,
  COALESCE(f.is_paused,0) AS is_paused,
  NULL AS raw_json
FROM sh_minute_facts f
JOIN sh_minute_fact_context_v2 v ON v.fact_id=f.id
JOIN sh_queue_revisions r ON r.id=v.queue_revision_id
LEFT JOIN sh_broadcast_sessions s ON s.id=f.broadcast_session_id
WHERE v.queue_available=1
  AND v.queue_revision_id IS NOT NULL
  AND r.queue_start_time IS NOT NULL;

ANALYZE sh_queue_revisions;
PRAGMA optimize;
