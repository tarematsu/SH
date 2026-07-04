CREATE TABLE IF NOT EXISTS sh_compaction_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  last_cleanup_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO sh_compaction_state(id,last_cleanup_at) VALUES(1,0);

CREATE TRIGGER IF NOT EXISTS trg_sh_claim_retention
AFTER INSERT ON sh_ingest_claims
WHEN NEW.observed_at-(SELECT last_cleanup_at FROM sh_compaction_state WHERE id=1)>=86400000
BEGIN
  DELETE FROM sh_ingest_claims WHERE observed_at<NEW.observed_at-604800000;
  DELETE FROM sh_ingest_conflicts WHERE observed_at<NEW.observed_at-2592000000;
  DELETE FROM sh_comment_minute_counts WHERE bucket_start<NEW.observed_at-172800000;
  UPDATE sh_compaction_state SET last_cleanup_at=NEW.observed_at WHERE id=1;
END;
