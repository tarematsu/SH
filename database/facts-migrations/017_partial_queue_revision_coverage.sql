ALTER TABLE sh_queue_revisions ADD COLUMN materialized_item_count INTEGER;
ALTER TABLE sh_queue_revisions ADD COLUMN coverage_complete INTEGER NOT NULL DEFAULT 1;

UPDATE sh_queue_revisions
SET materialized_item_count=item_count
WHERE materialized_item_count IS NULL;

CREATE INDEX IF NOT EXISTS idx_sh_queue_revisions_coverage
  ON sh_queue_revisions(channel_id,coverage_complete,effective_at DESC);
