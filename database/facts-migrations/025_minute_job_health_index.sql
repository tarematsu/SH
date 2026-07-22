-- Keep dead-job health counts and bounded recovery scans off the completed-job table.
CREATE INDEX IF NOT EXISTS idx_sh_minute_fact_jobs_dead_health
ON sh_minute_fact_jobs(updated_at ASC, id ASC)
WHERE status='dead';

ANALYZE sh_minute_fact_jobs;
