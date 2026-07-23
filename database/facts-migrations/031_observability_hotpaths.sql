-- Keep sparse revision recovery as an indexed rescue path. Normal continuation
-- is Queue-driven when an incomplete revision is created.
CREATE INDEX IF NOT EXISTS idx_sh_queue_revisions_sparse_recovery
ON sh_queue_revisions(
  COALESCE(last_materialized_at,effective_at),
  effective_at,
  id
)
WHERE source_job_id IS NOT NULL
  AND COALESCE(coverage_complete,0)=0
  AND COALESCE(source_visible_count,0)>COALESCE(materialized_item_count,0);

-- Track-history queue identities are maintained incrementally as complete
-- revisions arrive, avoiding a repeated DISTINCT scan over every queue item.
CREATE TABLE IF NOT EXISTS sh_track_history_queue_starts (
  station_id INTEGER NOT NULL,
  start_time INTEGER NOT NULL,
  day_at INTEGER NOT NULL,
  latest_revision_id INTEGER NOT NULL,
  latest_effective_at INTEGER NOT NULL,
  PRIMARY KEY(station_id,start_time)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_sh_track_history_queue_starts_time
ON sh_track_history_queue_starts(start_time,station_id);

CREATE INDEX IF NOT EXISTS idx_sh_track_history_queue_starts_day
ON sh_track_history_queue_starts(day_at,station_id,start_time);

INSERT INTO sh_track_history_queue_starts(
  station_id,start_time,day_at,latest_revision_id,latest_effective_at
)
SELECT r.station_id,r.queue_start_time,
  CAST(r.queue_start_time/86400000 AS INTEGER)*86400000,
  r.id,r.effective_at
FROM sh_queue_revisions r
WHERE r.status='complete'
  AND r.station_id IS NOT NULL
  AND r.queue_start_time IS NOT NULL
  AND r.id=(
    SELECT latest.id
    FROM sh_queue_revisions latest
    WHERE latest.status='complete'
      AND latest.queue_start_time=r.queue_start_time
      AND latest.channel_id=r.channel_id
      AND COALESCE(latest.station_id,-1)=COALESCE(r.station_id,-1)
    ORDER BY latest.effective_at DESC,latest.id DESC
    LIMIT 1
  )
ON CONFLICT(station_id,start_time) DO UPDATE SET
  day_at=excluded.day_at,
  latest_revision_id=excluded.latest_revision_id,
  latest_effective_at=excluded.latest_effective_at
WHERE excluded.latest_effective_at>sh_track_history_queue_starts.latest_effective_at
   OR (excluded.latest_effective_at=sh_track_history_queue_starts.latest_effective_at
       AND excluded.latest_revision_id>sh_track_history_queue_starts.latest_revision_id);

DROP TRIGGER IF EXISTS trg_sh_track_history_queue_start_after_insert;
CREATE TRIGGER trg_sh_track_history_queue_start_after_insert
AFTER INSERT ON sh_queue_revisions
WHEN NEW.status='complete'
  AND NEW.station_id IS NOT NULL
  AND NEW.queue_start_time IS NOT NULL
BEGIN
  INSERT INTO sh_track_history_queue_starts(
    station_id,start_time,day_at,latest_revision_id,latest_effective_at
  ) VALUES(
    NEW.station_id,NEW.queue_start_time,
    CAST(NEW.queue_start_time/86400000 AS INTEGER)*86400000,
    NEW.id,NEW.effective_at
  )
  ON CONFLICT(station_id,start_time) DO UPDATE SET
    day_at=excluded.day_at,
    latest_revision_id=excluded.latest_revision_id,
    latest_effective_at=excluded.latest_effective_at
  WHERE excluded.latest_effective_at>sh_track_history_queue_starts.latest_effective_at
     OR (excluded.latest_effective_at=sh_track_history_queue_starts.latest_effective_at
         AND excluded.latest_revision_id>sh_track_history_queue_starts.latest_revision_id);
END;

DROP TRIGGER IF EXISTS trg_sh_track_history_queue_start_after_update;
CREATE TRIGGER trg_sh_track_history_queue_start_after_update
AFTER UPDATE OF status,station_id,queue_start_time,effective_at ON sh_queue_revisions
WHEN NEW.status='complete'
  AND NEW.station_id IS NOT NULL
  AND NEW.queue_start_time IS NOT NULL
BEGIN
  INSERT INTO sh_track_history_queue_starts(
    station_id,start_time,day_at,latest_revision_id,latest_effective_at
  ) VALUES(
    NEW.station_id,NEW.queue_start_time,
    CAST(NEW.queue_start_time/86400000 AS INTEGER)*86400000,
    NEW.id,NEW.effective_at
  )
  ON CONFLICT(station_id,start_time) DO UPDATE SET
    day_at=excluded.day_at,
    latest_revision_id=excluded.latest_revision_id,
    latest_effective_at=excluded.latest_effective_at
  WHERE excluded.latest_effective_at>sh_track_history_queue_starts.latest_effective_at
     OR (excluded.latest_effective_at=sh_track_history_queue_starts.latest_effective_at
         AND excluded.latest_revision_id>sh_track_history_queue_starts.latest_revision_id);
END;

ANALYZE sh_queue_revisions;
ANALYZE sh_track_history_queue_starts;
PRAGMA optimize;
