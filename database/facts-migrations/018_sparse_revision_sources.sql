ALTER TABLE sh_queue_revisions ADD COLUMN source_job_id INTEGER;
ALTER TABLE sh_queue_revisions ADD COLUMN source_visible_count INTEGER;
ALTER TABLE sh_queue_revisions ADD COLUMN last_materialized_at INTEGER;

UPDATE sh_queue_revisions
SET source_visible_count=COALESCE(materialized_item_count,item_count)
WHERE source_visible_count IS NULL;

CREATE INDEX IF NOT EXISTS idx_sh_queue_revisions_source_job
  ON sh_queue_revisions(source_job_id)
  WHERE source_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sh_queue_revisions_materialization
  ON sh_queue_revisions(coverage_complete,last_materialized_at,effective_at);
