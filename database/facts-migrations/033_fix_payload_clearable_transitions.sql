-- Keep minute-fact payload cleanup eligibility correct when revision ownership
-- changes or a job leaves the completed state.

DROP TRIGGER IF EXISTS trg_sh_minute_fact_payload_after_job_done;
CREATE TRIGGER trg_sh_minute_fact_payload_after_job_done
AFTER UPDATE OF status ON sh_minute_fact_jobs
BEGIN
  UPDATE sh_minute_fact_jobs
  SET payload_clearable=CASE WHEN NEW.status='done' AND NOT EXISTS (
    SELECT 1 FROM sh_queue_revisions revisions
    WHERE revisions.source_job_id=NEW.id
      AND (revisions.status<>'complete'
        OR COALESCE(revisions.materialized_item_count,0)
          <COALESCE(revisions.source_visible_count,revisions.item_count,0))
  ) THEN 1 ELSE 0 END
  WHERE id=NEW.id;
END;

DROP TRIGGER IF EXISTS trg_sh_minute_fact_payload_after_revision_update;
CREATE TRIGGER trg_sh_minute_fact_payload_after_revision_update
AFTER UPDATE OF source_job_id,status,materialized_item_count,source_visible_count,item_count
ON sh_queue_revisions
BEGIN
  UPDATE sh_minute_fact_jobs
  SET payload_clearable=CASE WHEN status='done' AND NOT EXISTS (
    SELECT 1 FROM sh_queue_revisions revisions
    WHERE revisions.source_job_id=sh_minute_fact_jobs.id
      AND (revisions.status<>'complete'
        OR COALESCE(revisions.materialized_item_count,0)
          <COALESCE(revisions.source_visible_count,revisions.item_count,0))
  ) THEN 1 ELSE 0 END
  WHERE id=OLD.source_job_id OR id=NEW.source_job_id;
END;

DROP TRIGGER IF EXISTS trg_sh_minute_fact_payload_after_revision_delete;
CREATE TRIGGER trg_sh_minute_fact_payload_after_revision_delete
AFTER DELETE ON sh_queue_revisions
WHEN OLD.source_job_id IS NOT NULL
BEGIN
  UPDATE sh_minute_fact_jobs
  SET payload_clearable=CASE WHEN status='done' AND NOT EXISTS (
    SELECT 1 FROM sh_queue_revisions revisions
    WHERE revisions.source_job_id=OLD.source_job_id
      AND (revisions.status<>'complete'
        OR COALESCE(revisions.materialized_item_count,0)
          <COALESCE(revisions.source_visible_count,revisions.item_count,0))
  ) THEN 1 ELSE 0 END
  WHERE id=OLD.source_job_id;
END;

ANALYZE sh_minute_fact_jobs;
ANALYZE sh_queue_revisions;
PRAGMA optimize;
