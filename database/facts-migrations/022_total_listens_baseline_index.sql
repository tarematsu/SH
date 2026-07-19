DROP INDEX IF EXISTS idx_sh_minute_facts_total_listens_baseline;

CREATE INDEX idx_sh_minute_facts_total_listens_baseline
ON sh_minute_facts(
  channel_id,
  minute_at DESC,
  id DESC,
  observed_at,
  reported_total_listens
)
WHERE source_code=1 AND reported_total_listens IS NOT NULL;
