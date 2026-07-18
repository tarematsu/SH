ALTER TABLE sh_queue_revisions ADD COLUMN total_item_count INTEGER;
ALTER TABLE sh_queue_revisions ADD COLUMN coverage_complete INTEGER NOT NULL DEFAULT 1;

UPDATE sh_queue_revisions
SET total_item_count=item_count
WHERE total_item_count IS NULL;

CREATE INDEX IF NOT EXISTS idx_sh_queue_revisions_coverage
  ON sh_queue_revisions(channel_id,coverage_complete,effective_at DESC);

DROP VIEW IF EXISTS sh_minute_fact_context_resolved;
DROP VIEW IF EXISTS sh_minute_fact_context;

CREATE VIEW sh_minute_fact_context AS
SELECT v.fact_id,
  COALESCE(v.station_id_override,s.station_id) AS station_id,
  COALESCE(v.host_id_override,s.host_id) AS host_id,
  COALESCE(v.broadcast_start_time_override,s.broadcast_start_time) AS broadcast_start_time,
  v.queue_revision_id,r.queue_id,r.queue_start_time,
  COALESCE(r.total_item_count,r.item_count) AS queue_track_count,
  v.queue_available,i.track_id,v.queue_position,
  COALESCE((SELECT cc.count_value FROM sh_track_counter_changes cc
    WHERE cc.occurrence_key='revision:'||CAST(v.queue_revision_id AS TEXT)||':'||CAST(v.queue_position AS TEXT)
    ORDER BY cc.observed_at DESC,cc.id DESC LIMIT 1),i.bite_count) AS track_bite_count
FROM sh_minute_fact_context_v2 v
LEFT JOIN sh_minute_facts f ON f.id=v.fact_id
LEFT JOIN sh_broadcast_sessions s ON s.id=f.broadcast_session_id
LEFT JOIN sh_queue_revisions r ON r.id=v.queue_revision_id
LEFT JOIN sh_queue_revision_items i
  ON i.revision_id=v.queue_revision_id AND i.position=v.queue_position;

CREATE VIEW sh_minute_fact_context_resolved AS
SELECT fact_id,station_id,host_id,broadcast_start_time
FROM sh_minute_fact_context;
