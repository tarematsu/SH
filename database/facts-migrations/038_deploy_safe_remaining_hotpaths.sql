-- Apply only deployment-critical schema for the remaining hotpaths. Existing
-- and new track aliases are filled lazily by the alias-first resolver; a full
-- sh_tracks backfill must not block production rollout.
DROP INDEX IF EXISTS idx_sh_minute_fact_jobs_pending_dispatch;
DROP INDEX IF EXISTS idx_sh_minute_fact_jobs_due;
CREATE INDEX IF NOT EXISTS idx_sh_minute_fact_jobs_pending_ready
ON sh_minute_fact_jobs(next_attempt_at ASC,job_priority DESC,minute_at ASC,id ASC)
WHERE status='pending';

DROP VIEW IF EXISTS sh_minute_fact_context;
CREATE VIEW sh_minute_fact_context AS
SELECT v.fact_id,
  COALESCE(v.station_id_override,s.station_id) AS station_id,
  COALESCE(v.host_id_override,s.host_id) AS host_id,
  COALESCE(v.broadcast_start_time_override,s.broadcast_start_time) AS broadcast_start_time,
  v.queue_revision_id,r.queue_id,r.queue_start_time,r.item_count AS queue_track_count,
  v.queue_available,i.track_id,
  COALESCE(f.queue_position_patch,v.queue_position) AS queue_position,
  COALESCE((SELECT cc.count_value FROM sh_track_counter_changes cc
    WHERE cc.occurrence_key='revision:'||CAST(v.queue_revision_id AS TEXT)||':'||
      CAST(COALESCE(f.queue_position_patch,v.queue_position) AS TEXT)
    ORDER BY cc.observed_at DESC,cc.id DESC LIMIT 1),i.bite_count) AS track_bite_count
FROM sh_minute_fact_context_v2 v
LEFT JOIN sh_minute_facts f ON f.id=v.fact_id
LEFT JOIN sh_broadcast_sessions s ON s.id=f.broadcast_session_id
LEFT JOIN sh_queue_revisions r ON r.id=v.queue_revision_id
LEFT JOIN sh_queue_revision_items i
  ON i.revision_id=v.queue_revision_id
  AND i.position=COALESCE(f.queue_position_patch,v.queue_position);
