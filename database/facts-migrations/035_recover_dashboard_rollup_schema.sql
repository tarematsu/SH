-- Restore the deployment-critical MINUTE_DB objects without blocking Worker
-- recovery on the historical 25-hour dashboard backfill. New minute facts fill
-- the rollup incrementally; historical repair can run outside the deploy gate.
CREATE TABLE IF NOT EXISTS sh_dashboard_history_5m (
  channel_id INTEGER NOT NULL,
  bucket_at INTEGER NOT NULL,
  fact_id INTEGER NOT NULL,
  minute_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  listener_count INTEGER,
  online_member_count INTEGER,
  total_member_count INTEGER,
  total_listens INTEGER,
  current_stream_count INTEGER,
  comment_velocity INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(channel_id,bucket_at)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_sh_dashboard_history_5m_recent
ON sh_dashboard_history_5m(bucket_at DESC,channel_id);

CREATE TABLE IF NOT EXISTS sh_minute_fact_inbox_stats (
  id TEXT PRIMARY KEY,
  pending_count INTEGER NOT NULL DEFAULT 0,
  processing_count INTEGER NOT NULL DEFAULT 0,
  dead_count INTEGER NOT NULL DEFAULT 0,
  rebuild_pending_count INTEGER NOT NULL DEFAULT 0,
  live_pending_count INTEGER NOT NULL DEFAULT 0,
  oldest_pending_minute INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK(id='global')
) WITHOUT ROWID;

INSERT INTO sh_minute_fact_inbox_stats(
  id,pending_count,processing_count,dead_count,
  rebuild_pending_count,live_pending_count,oldest_pending_minute,updated_at
)
SELECT 'global',
  COALESCE(SUM(status='pending'),0),
  COALESCE(SUM(status='processing'),0),
  COALESCE(SUM(status='dead'),0),
  COALESCE(SUM(status='pending' AND job_kind='rebuild'),0),
  COALESCE(SUM(status='pending' AND job_kind='live'),0),
  MIN(CASE WHEN status='pending' THEN minute_at END),
  unixepoch()*1000
FROM sh_minute_fact_jobs
WHERE 1=1
ON CONFLICT(id) DO UPDATE SET
  pending_count=excluded.pending_count,
  processing_count=excluded.processing_count,
  dead_count=excluded.dead_count,
  rebuild_pending_count=excluded.rebuild_pending_count,
  live_pending_count=excluded.live_pending_count,
  oldest_pending_minute=excluded.oldest_pending_minute,
  updated_at=excluded.updated_at;

CREATE TRIGGER IF NOT EXISTS trg_sh_minute_fact_inbox_stats_insert
AFTER INSERT ON sh_minute_fact_jobs
BEGIN
  UPDATE sh_minute_fact_inbox_stats SET
    pending_count=pending_count+CASE WHEN NEW.status='pending' THEN 1 ELSE 0 END,
    processing_count=processing_count+CASE WHEN NEW.status='processing' THEN 1 ELSE 0 END,
    dead_count=dead_count+CASE WHEN NEW.status='dead' THEN 1 ELSE 0 END,
    rebuild_pending_count=rebuild_pending_count
      +CASE WHEN NEW.status='pending' AND NEW.job_kind='rebuild' THEN 1 ELSE 0 END,
    live_pending_count=live_pending_count
      +CASE WHEN NEW.status='pending' AND NEW.job_kind='live' THEN 1 ELSE 0 END,
    oldest_pending_minute=CASE
      WHEN NEW.status='pending' AND (
        oldest_pending_minute IS NULL OR NEW.minute_at<oldest_pending_minute
      ) THEN NEW.minute_at
      ELSE oldest_pending_minute
    END,
    updated_at=MAX(updated_at,NEW.updated_at)
  WHERE id='global';
END;

CREATE TRIGGER IF NOT EXISTS trg_sh_minute_fact_inbox_stats_delete
AFTER DELETE ON sh_minute_fact_jobs
BEGIN
  UPDATE sh_minute_fact_inbox_stats SET
    pending_count=MAX(0,pending_count-CASE WHEN OLD.status='pending' THEN 1 ELSE 0 END),
    processing_count=MAX(0,processing_count-CASE WHEN OLD.status='processing' THEN 1 ELSE 0 END),
    dead_count=MAX(0,dead_count-CASE WHEN OLD.status='dead' THEN 1 ELSE 0 END),
    rebuild_pending_count=MAX(0,rebuild_pending_count
      -CASE WHEN OLD.status='pending' AND OLD.job_kind='rebuild' THEN 1 ELSE 0 END),
    live_pending_count=MAX(0,live_pending_count
      -CASE WHEN OLD.status='pending' AND OLD.job_kind='live' THEN 1 ELSE 0 END),
    oldest_pending_minute=CASE
      WHEN OLD.status='pending' AND oldest_pending_minute=OLD.minute_at
        THEN (SELECT MIN(minute_at) FROM sh_minute_fact_jobs WHERE status='pending')
      ELSE oldest_pending_minute
    END,
    updated_at=unixepoch()*1000
  WHERE id='global';
END;

CREATE TRIGGER IF NOT EXISTS trg_sh_minute_fact_inbox_stats_update
AFTER UPDATE OF status,job_kind,minute_at ON sh_minute_fact_jobs
WHEN OLD.status IS NOT NEW.status
  OR OLD.job_kind IS NOT NEW.job_kind
  OR OLD.minute_at IS NOT NEW.minute_at
BEGIN
  UPDATE sh_minute_fact_inbox_stats SET
    pending_count=MAX(0,pending_count
      -CASE WHEN OLD.status='pending' THEN 1 ELSE 0 END
      +CASE WHEN NEW.status='pending' THEN 1 ELSE 0 END),
    processing_count=MAX(0,processing_count
      -CASE WHEN OLD.status='processing' THEN 1 ELSE 0 END
      +CASE WHEN NEW.status='processing' THEN 1 ELSE 0 END),
    dead_count=MAX(0,dead_count
      -CASE WHEN OLD.status='dead' THEN 1 ELSE 0 END
      +CASE WHEN NEW.status='dead' THEN 1 ELSE 0 END),
    rebuild_pending_count=MAX(0,rebuild_pending_count
      -CASE WHEN OLD.status='pending' AND OLD.job_kind='rebuild' THEN 1 ELSE 0 END
      +CASE WHEN NEW.status='pending' AND NEW.job_kind='rebuild' THEN 1 ELSE 0 END),
    live_pending_count=MAX(0,live_pending_count
      -CASE WHEN OLD.status='pending' AND OLD.job_kind='live' THEN 1 ELSE 0 END
      +CASE WHEN NEW.status='pending' AND NEW.job_kind='live' THEN 1 ELSE 0 END),
    oldest_pending_minute=CASE
      WHEN NEW.status='pending' AND (
        oldest_pending_minute IS NULL OR NEW.minute_at<oldest_pending_minute
      ) THEN NEW.minute_at
      WHEN OLD.status='pending'
        AND oldest_pending_minute=OLD.minute_at
        AND (NEW.status<>'pending' OR NEW.minute_at<>OLD.minute_at)
        THEN (SELECT MIN(minute_at) FROM sh_minute_fact_jobs WHERE status='pending')
      ELSE oldest_pending_minute
    END,
    updated_at=MAX(updated_at,NEW.updated_at)
  WHERE id='global';
END;
