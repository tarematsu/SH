-- The dashboard and playback endpoints repeatedly need the newest live fact.
-- A full composite index is more reliable for D1's planner than the former
-- partial index and turns a multi-million-row scan into an index seek.
DROP INDEX IF EXISTS idx_sh_minute_facts_live_minute;

CREATE INDEX idx_sh_minute_facts_live_minute
ON sh_minute_facts(source_code, minute_at DESC, id DESC);

-- Status summaries and recovery dispatch must not scan the accumulated job
-- ledger. Historical rebuild jobs remain durable but are excluded by policy.
CREATE INDEX IF NOT EXISTS idx_sh_minute_fact_jobs_status_kind_minute
ON sh_minute_fact_jobs(status, job_kind, minute_at, id);
