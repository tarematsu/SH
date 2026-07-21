-- Historical databases may still carry the old compaction trigger, which
-- deleted minute comment counts after only two days. Reconstruction needs the
-- same thirty-day horizon as channel and queue snapshots, so retention is now
-- owned exclusively by worker/src/snapshot-retention.js.
DROP TRIGGER IF EXISTS trg_sh_claim_retention;

CREATE INDEX IF NOT EXISTS idx_sh_comment_minute_counts_bucket
  ON sh_comment_minute_counts(bucket_start DESC);
