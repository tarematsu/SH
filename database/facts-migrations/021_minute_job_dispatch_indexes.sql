CREATE INDEX IF NOT EXISTS idx_sh_minute_fact_jobs_pending_dispatch
ON sh_minute_fact_jobs(job_priority DESC, minute_at ASC, id ASC, next_attempt_at)
WHERE status='pending';

CREATE INDEX IF NOT EXISTS idx_sh_minute_fact_jobs_processing_lease
ON sh_minute_fact_jobs(lease_until ASC, id ASC)
WHERE status='processing';
