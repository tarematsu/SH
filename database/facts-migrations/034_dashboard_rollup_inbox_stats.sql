-- Materialize the dashboard's five-minute history so public refreshes never
-- rescan a full day of minute facts.
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

DELETE FROM sh_dashboard_history_5m
WHERE bucket_at>=unixepoch('now','-26 hours')*1000;

WITH bounds AS (
  SELECT unixepoch('now','-25 hours')*1000 AS from_at
), comment_points AS (
  SELECT f.id,f.channel_id,f.minute_at,f.observed_at,
    f.listener_count,f.online_member_count,f.total_member_count,
    f.reported_total_listens AS total_listens,
    f.reported_current_stream_count AS current_stream_count,
    COALESCE(SUM(COALESCE(f.comment_count,0)) OVER (
      PARTITION BY f.channel_id
      ORDER BY f.minute_at
      RANGE BETWEEN 60000 PRECEDING AND CURRENT ROW
    ),0) AS comment_velocity
  FROM sh_minute_facts f
  WHERE f.source_code=1
    AND f.minute_at>=(SELECT from_at FROM bounds)-60000
), ranked AS (
  SELECT comment_points.*,
    CAST(minute_at/300000 AS INTEGER)*300000 AS bucket_at,
    MAX(comment_velocity) OVER (
      PARTITION BY channel_id,CAST(minute_at/300000 AS INTEGER)
    ) AS comment_velocity_max,
    ROW_NUMBER() OVER (
      PARTITION BY channel_id,CAST(minute_at/300000 AS INTEGER)
      ORDER BY minute_at DESC,id DESC
    ) AS bucket_rank
  FROM comment_points
  WHERE minute_at>=(SELECT from_at FROM bounds)
)
INSERT INTO sh_dashboard_history_5m(
  channel_id,bucket_at,fact_id,minute_at,observed_at,
  listener_count,online_member_count,total_member_count,total_listens,
  current_stream_count,comment_velocity
)
SELECT channel_id,bucket_at,id,minute_at,observed_at,
  listener_count,online_member_count,total_member_count,total_listens,
  current_stream_count,comment_velocity_max
FROM ranked
WHERE bucket_rank=1
ON CONFLICT(channel_id,bucket_at) DO UPDATE SET
  fact_id=excluded.fact_id,
  minute_at=excluded.minute_at,
  observed_at=excluded.observed_at,
  listener_count=excluded.listener_count,
  online_member_count=excluded.online_member_count,
  total_member_count=excluded.total_member_count,
  total_listens=excluded.total_listens,
  current_stream_count=excluded.current_stream_count,
  comment_velocity=excluded.comment_velocity;

-- Persist inbox counts. Normal health reads become one primary-key lookup.
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

DROP TRIGGER IF EXISTS trg_sh_minute_fact_inbox_stats_insert;
CREATE TRIGGER trg_sh_minute_fact_inbox_stats_insert
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

DROP TRIGGER IF EXISTS trg_sh_minute_fact_inbox_stats_delete;
CREATE TRIGGER trg_sh_minute_fact_inbox_stats_delete
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

DROP TRIGGER IF EXISTS trg_sh_minute_fact_inbox_stats_update;
CREATE TRIGGER trg_sh_minute_fact_inbox_stats_update
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

ANALYZE sh_dashboard_history_5m;
ANALYZE sh_minute_fact_inbox_stats;
PRAGMA optimize;
