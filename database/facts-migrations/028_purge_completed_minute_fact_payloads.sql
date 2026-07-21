-- Keep the durable job ledger, but discard the large source payload as soon as
-- the minute fact and every queue-revision item that depends on it are complete.
-- The cleared value is the valid minimal JSON object `{}` because downstream
-- duplicate deliveries may still evaluate payload_json with SQLite JSON functions.

DROP INDEX IF EXISTS idx_sh_minute_fact_jobs_done_payload;
CREATE INDEX idx_sh_minute_fact_jobs_done_payload
  ON sh_minute_fact_jobs(COALESCE(processed_at,updated_at),id)
  WHERE status='done' AND LENGTH(payload_json)>2;

-- Purge the existing completed payload backlog in one migration-wide statement.
-- Rows with an unfinished queue revision retain their source until the revision
-- completion trigger below proves that every dependent item has materialized.
UPDATE sh_minute_fact_jobs
SET payload_json='{}'
WHERE status='done' AND LENGTH(payload_json)>2
  AND NOT EXISTS (
    SELECT 1 FROM sh_queue_revisions revisions
    WHERE revisions.source_job_id=sh_minute_fact_jobs.id
      AND (revisions.status<>'complete'
        OR COALESCE(revisions.materialized_item_count,0)
          <COALESCE(revisions.source_visible_count,revisions.item_count,0))
  );

DROP TRIGGER IF EXISTS trg_sh_minute_fact_payload_after_job_done;
CREATE TRIGGER trg_sh_minute_fact_payload_after_job_done
AFTER UPDATE OF status ON sh_minute_fact_jobs
WHEN NEW.status='done' AND LENGTH(NEW.payload_json)>2
  AND NOT EXISTS (
    SELECT 1 FROM sh_queue_revisions revisions
    WHERE revisions.source_job_id=NEW.id
      AND (revisions.status<>'complete'
        OR COALESCE(revisions.materialized_item_count,0)
          <COALESCE(revisions.source_visible_count,revisions.item_count,0))
  )
BEGIN
  UPDATE sh_minute_fact_jobs SET payload_json='{}' WHERE id=NEW.id;
END;

DROP TRIGGER IF EXISTS trg_sh_minute_fact_payload_after_revision_insert;
CREATE TRIGGER trg_sh_minute_fact_payload_after_revision_insert
AFTER INSERT ON sh_queue_revisions
WHEN NEW.source_job_id IS NOT NULL
  AND NEW.status='complete'
  AND COALESCE(NEW.materialized_item_count,0)
    >=COALESCE(NEW.source_visible_count,NEW.item_count,0)
BEGIN
  UPDATE sh_minute_fact_jobs
  SET payload_json='{}'
  WHERE id=NEW.source_job_id AND status='done' AND LENGTH(payload_json)>2
    AND NOT EXISTS (
      SELECT 1 FROM sh_queue_revisions revisions
      WHERE revisions.source_job_id=NEW.source_job_id
        AND (revisions.status<>'complete'
          OR COALESCE(revisions.materialized_item_count,0)
            <COALESCE(revisions.source_visible_count,revisions.item_count,0))
    );
END;

DROP TRIGGER IF EXISTS trg_sh_minute_fact_payload_after_revision_update;
CREATE TRIGGER trg_sh_minute_fact_payload_after_revision_update
AFTER UPDATE OF status,materialized_item_count,source_visible_count,item_count
ON sh_queue_revisions
WHEN NEW.source_job_id IS NOT NULL
  AND NEW.status='complete'
  AND COALESCE(NEW.materialized_item_count,0)
    >=COALESCE(NEW.source_visible_count,NEW.item_count,0)
BEGIN
  UPDATE sh_minute_fact_jobs
  SET payload_json='{}'
  WHERE id=NEW.source_job_id AND status='done' AND LENGTH(payload_json)>2
    AND NOT EXISTS (
      SELECT 1 FROM sh_queue_revisions revisions
      WHERE revisions.source_job_id=NEW.source_job_id
        AND (revisions.status<>'complete'
          OR COALESCE(revisions.materialized_item_count,0)
            <COALESCE(revisions.source_visible_count,revisions.item_count,0))
    );
END;
