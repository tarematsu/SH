CREATE INDEX IF NOT EXISTS idx_sh_minute_facts_stream_observed
ON sh_minute_facts(observed_at, id)
WHERE reported_current_stream_count IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sh_minute_fact_jobs_due
ON sh_minute_fact_jobs(next_attempt_at, job_priority DESC, minute_at, id)
WHERE status='pending';

CREATE INDEX IF NOT EXISTS idx_sh_minute_fact_jobs_processing_lease
ON sh_minute_fact_jobs(lease_until, id)
WHERE status='processing';

CREATE INDEX IF NOT EXISTS idx_sh_queue_revisions_recent_complete
ON sh_queue_revisions(effective_at DESC, id DESC)
WHERE status='complete' AND source='live_collector';
