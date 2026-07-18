ALTER TABLE sh_queue_revisions ADD COLUMN materialized_item_count INTEGER;
ALTER TABLE sh_queue_revisions ADD COLUMN coverage_complete INTEGER NOT NULL DEFAULT 1;

UPDATE sh_queue_revisions
SET materialized_item_count=(
  SELECT COUNT(*) FROM sh_queue_revision_items i
  WHERE i.revision_id=sh_queue_revisions.id
)
WHERE materialized_item_count IS NULL;

UPDATE sh_queue_revisions
SET coverage_complete=CASE
  WHEN COALESCE(materialized_item_count,0)>=item_count THEN 1
  ELSE 0
END;

CREATE INDEX IF NOT EXISTS idx_sh_queue_revisions_coverage
  ON sh_queue_revisions(channel_id,coverage_complete,effective_at DESC);
