CREATE INDEX IF NOT EXISTS idx_sh_minute_facts_stream_observed
ON sh_minute_facts(observed_at, id)
WHERE reported_current_stream_count IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sh_minute_facts_live_minute
ON sh_minute_facts(minute_at DESC, id DESC)
WHERE source_code=1;

-- D1 did not consistently choose the partial live index for the public
-- playback CTE. Rebuild this as a covering latest-live seek so the existing
-- production Pages query does not scan every historical fact row.
DROP INDEX IF EXISTS idx_sh_minute_facts_source_minute_desc;
CREATE INDEX idx_sh_minute_facts_source_minute_desc
ON sh_minute_facts(
  source_code,
  minute_at DESC,
  id DESC,
  channel_id,
  observed_at,
  is_broadcasting
);

-- Bound channel-local minute ranges such as comment velocity and 24-hour
-- dashboard history. The source/channel prefix matches the deployed queries.
CREATE INDEX IF NOT EXISTS idx_sh_minute_facts_source_channel_minute_desc
ON sh_minute_facts(source_code, channel_id, minute_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_sh_broadcast_sessions_channel_start
ON sh_broadcast_sessions(channel_id, broadcast_start_time, first_observed_at, id);

CREATE INDEX IF NOT EXISTS idx_sh_tracks_stationhead_id
ON sh_tracks(stationhead_track_id)
WHERE stationhead_track_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sh_minute_fact_jobs_due
ON sh_minute_fact_jobs(next_attempt_at, job_priority DESC, minute_at, id)
WHERE status='pending';

CREATE INDEX IF NOT EXISTS idx_sh_minute_fact_jobs_processing_lease
ON sh_minute_fact_jobs(lease_until, id)
WHERE status='processing';

-- Payload cleanup previously scanned every completed job. Match its exact
-- predicate and ordering so maintenance seeks only retained payload rows.
CREATE INDEX IF NOT EXISTS idx_sh_minute_fact_jobs_done_payload
ON sh_minute_fact_jobs(COALESCE(processed_at,updated_at), id)
WHERE status='done' AND LENGTH(payload_json)>2;

CREATE INDEX IF NOT EXISTS idx_sh_queue_revisions_recent_complete
ON sh_queue_revisions(effective_at DESC, id DESC)
WHERE status='complete' AND source='live_collector';

CREATE INDEX IF NOT EXISTS idx_sh_queue_revisions_reuse
ON sh_queue_revisions(
  channel_id,
  structural_hash,
  session_id,
  queue_start_time,
  effective_at DESC,
  id DESC
)
WHERE status IN ('complete','pending');

-- Refresh planner statistics after rebuilding the high-cardinality indexes.
-- Without this D1 can retain the old full-table plan across deployments.
ANALYZE sh_minute_facts;
ANALYZE sh_minute_fact_jobs;
