-- The dashboard and playback endpoints repeatedly need the newest live fact.
-- Keep the selected playback columns in the index so D1 can satisfy the lookup
-- without falling back to the multi-million-row fact table.
DROP INDEX IF EXISTS idx_sh_minute_facts_live_minute;

CREATE INDEX idx_sh_minute_facts_live_minute
ON sh_minute_facts(
  source_code,
  minute_at DESC,
  id DESC,
  channel_id,
  observed_at,
  is_broadcasting
);

-- Status summaries and recovery dispatch must not scan the accumulated job
-- ledger. Historical rebuild jobs remain durable but are excluded by policy.
CREATE INDEX IF NOT EXISTS idx_sh_minute_fact_jobs_status_kind_minute
ON sh_minute_fact_jobs(status, job_kind, minute_at, id);
