
CREATE INDEX IF NOT EXISTS idx_sh_queue_items_start_observed
ON sh_queue_items(start_time, observed_at);
