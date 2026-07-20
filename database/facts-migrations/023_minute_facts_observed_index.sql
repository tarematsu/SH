-- Keep the production verification probe on the newest observed fact without
-- scanning the full minute-facts table on every scheduled check.
CREATE INDEX IF NOT EXISTS idx_sh_minute_facts_observed_id
  ON sh_minute_facts(observed_at DESC,id DESC);
