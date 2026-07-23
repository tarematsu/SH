-- Convert repeated cleanup/ranking scans into update-time materialized state.

ALTER TABLE sh_minute_fact_jobs
  ADD COLUMN payload_clearable INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sh_queue_revisions_payload_blocking
ON sh_queue_revisions(source_job_id,id)
WHERE source_job_id IS NOT NULL
  AND (status<>'complete'
    OR COALESCE(materialized_item_count,0)
      <COALESCE(source_visible_count,item_count,0));

-- One-time migration backfill. Runtime cleanup uses the partial index below and
-- never repeats the revision anti-join.
UPDATE sh_minute_fact_jobs AS jobs
SET payload_clearable=1
WHERE jobs.status='done'
  AND LENGTH(jobs.payload_json)>2
  AND NOT EXISTS (
    SELECT 1 FROM sh_queue_revisions revisions
    WHERE revisions.source_job_id=jobs.id
      AND (revisions.status<>'complete'
        OR COALESCE(revisions.materialized_item_count,0)
          <COALESCE(revisions.source_visible_count,revisions.item_count,0))
  );

DROP INDEX IF EXISTS idx_sh_minute_fact_jobs_done_payload;
CREATE INDEX idx_sh_minute_fact_jobs_payload_clearable
ON sh_minute_fact_jobs(COALESCE(processed_at,updated_at),id)
WHERE payload_clearable=1 AND LENGTH(payload_json)>2;

DROP TRIGGER IF EXISTS trg_sh_minute_fact_payload_after_job_done;
CREATE TRIGGER trg_sh_minute_fact_payload_after_job_done
AFTER UPDATE OF status ON sh_minute_fact_jobs
WHEN NEW.status='done'
BEGIN
  UPDATE sh_minute_fact_jobs
  SET payload_clearable=CASE WHEN EXISTS (
    SELECT 1 FROM sh_queue_revisions revisions
    WHERE revisions.source_job_id=NEW.id
      AND (revisions.status<>'complete'
        OR COALESCE(revisions.materialized_item_count,0)
          <COALESCE(revisions.source_visible_count,revisions.item_count,0))
  ) THEN 0 ELSE 1 END
  WHERE id=NEW.id;
END;

DROP TRIGGER IF EXISTS trg_sh_minute_fact_payload_after_revision_insert;
CREATE TRIGGER trg_sh_minute_fact_payload_after_revision_insert
AFTER INSERT ON sh_queue_revisions
WHEN NEW.source_job_id IS NOT NULL
BEGIN
  UPDATE sh_minute_fact_jobs
  SET payload_clearable=CASE WHEN status='done' AND NOT EXISTS (
    SELECT 1 FROM sh_queue_revisions revisions
    WHERE revisions.source_job_id=NEW.source_job_id
      AND (revisions.status<>'complete'
        OR COALESCE(revisions.materialized_item_count,0)
          <COALESCE(revisions.source_visible_count,revisions.item_count,0))
  ) THEN 1 ELSE 0 END
  WHERE id=NEW.source_job_id;
END;

DROP TRIGGER IF EXISTS trg_sh_minute_fact_payload_after_revision_update;
CREATE TRIGGER trg_sh_minute_fact_payload_after_revision_update
AFTER UPDATE OF status,materialized_item_count,source_visible_count,item_count
ON sh_queue_revisions
WHEN NEW.source_job_id IS NOT NULL
BEGIN
  UPDATE sh_minute_fact_jobs
  SET payload_clearable=CASE WHEN status='done' AND NOT EXISTS (
    SELECT 1 FROM sh_queue_revisions revisions
    WHERE revisions.source_job_id=NEW.source_job_id
      AND (revisions.status<>'complete'
        OR COALESCE(revisions.materialized_item_count,0)
          <COALESCE(revisions.source_visible_count,revisions.item_count,0))
  ) THEN 1 ELSE 0 END
  WHERE id=NEW.source_job_id;
END;

-- Resolve identity once when an occurrence counter changes. One compact row per
-- occurrence preserves the old identity during updates so both the old and new
-- identity winners can be repaired without rescanning the source tables.
DROP VIEW IF EXISTS sh_track_ranking_candidates;
CREATE VIEW sh_track_ranking_candidates AS
SELECT resolved.*,
  CASE
    WHEN resolved.resolved_track_id IS NOT NULL
      THEN 'track:'||CAST(resolved.resolved_track_id AS TEXT)
    WHEN resolved.isrc IS NOT NULL AND TRIM(resolved.isrc)<>''
      THEN 'isrc:'||UPPER(TRIM(resolved.isrc))
    WHEN resolved.spotify_id IS NOT NULL AND TRIM(resolved.spotify_id)<>''
      THEN 'spotify:'||TRIM(resolved.spotify_id)
    ELSE 'key:'||resolved.track_key
  END AS track_identity
FROM (
  SELECT c.occurrence_key,c.observed_at,c.count_value,c.track_key,
    COALESCE(c.track_id,direct.id,by_isrc.id,by_spotify.id) AS resolved_track_id,
    COALESCE(direct.title,by_isrc.title,by_spotify.title) AS title,
    COALESCE(direct.artist,by_isrc.artist,by_spotify.artist) AS artist,
    COALESCE(c.isrc,direct.isrc,by_isrc.isrc,by_spotify.isrc) AS isrc,
    COALESCE(c.spotify_id,direct.spotify_id,by_isrc.spotify_id,by_spotify.spotify_id)
      AS spotify_id
  FROM sh_track_counter_current c
  LEFT JOIN sh_tracks direct ON direct.id=c.track_id
  LEFT JOIN sh_tracks by_isrc
    ON c.track_id IS NULL
   AND c.isrc IS NOT NULL AND TRIM(c.isrc)<>''
   AND by_isrc.isrc=UPPER(TRIM(c.isrc))
  LEFT JOIN sh_tracks by_spotify
    ON c.track_id IS NULL AND by_isrc.id IS NULL
   AND c.spotify_id IS NOT NULL AND TRIM(c.spotify_id)<>''
   AND by_spotify.spotify_id=TRIM(c.spotify_id)
  WHERE c.count_value>=0
) resolved
WHERE TRIM(COALESCE(resolved.artist,'')) LIKE '櫻坂%'
   OR UPPER(TRIM(COALESCE(resolved.isrc,''))) LIKE 'JP%';

CREATE TABLE IF NOT EXISTS sh_track_ranking_occurrence (
  occurrence_key TEXT PRIMARY KEY,
  track_identity TEXT NOT NULL,
  track_id INTEGER,
  title TEXT,
  artist TEXT,
  isrc TEXT,
  spotify_id TEXT,
  latest_like_count INTEGER NOT NULL,
  latest_observed_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_sh_track_ranking_occurrence_identity
ON sh_track_ranking_occurrence(
  track_identity,latest_observed_at DESC,occurrence_key DESC
);

CREATE TABLE IF NOT EXISTS sh_track_ranking_current (
  track_identity TEXT PRIMARY KEY,
  track_id INTEGER,
  title TEXT,
  artist TEXT,
  isrc TEXT,
  spotify_id TEXT,
  latest_like_count INTEGER NOT NULL,
  latest_observed_at INTEGER NOT NULL,
  latest_occurrence_key TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_sh_track_ranking_current_order
ON sh_track_ranking_current(
  latest_like_count DESC,latest_observed_at DESC,track_identity
);
CREATE INDEX IF NOT EXISTS idx_sh_track_ranking_current_observed
ON sh_track_ranking_current(latest_observed_at DESC,track_identity);

DELETE FROM sh_track_ranking_occurrence;
INSERT INTO sh_track_ranking_occurrence(
  occurrence_key,track_identity,track_id,title,artist,isrc,spotify_id,
  latest_like_count,latest_observed_at
)
SELECT occurrence_key,track_identity,resolved_track_id,title,artist,isrc,spotify_id,
  count_value,observed_at
FROM sh_track_ranking_candidates;

DELETE FROM sh_track_ranking_current;
INSERT INTO sh_track_ranking_current(
  track_identity,track_id,title,artist,isrc,spotify_id,
  latest_like_count,latest_observed_at,latest_occurrence_key
)
SELECT track_identity,track_id,title,artist,isrc,spotify_id,
  latest_like_count,latest_observed_at,occurrence_key
FROM (
  SELECT occurrences.*,
    ROW_NUMBER() OVER (
      PARTITION BY track_identity
      ORDER BY latest_observed_at DESC,occurrence_key DESC
    ) AS identity_rank
  FROM sh_track_ranking_occurrence occurrences
)
WHERE identity_rank=1 AND latest_like_count>0;

DROP TRIGGER IF EXISTS trg_sh_track_ranking_current_after_counter_insert;
CREATE TRIGGER trg_sh_track_ranking_current_after_counter_insert
AFTER INSERT ON sh_track_counter_current
BEGIN
  INSERT OR REPLACE INTO sh_track_ranking_occurrence(
    occurrence_key,track_identity,track_id,title,artist,isrc,spotify_id,
    latest_like_count,latest_observed_at
  )
  SELECT occurrence_key,track_identity,resolved_track_id,title,artist,isrc,spotify_id,
    count_value,observed_at
  FROM sh_track_ranking_candidates
  WHERE occurrence_key=NEW.occurrence_key;

  DELETE FROM sh_track_ranking_current
  WHERE track_identity=(
    SELECT track_identity FROM sh_track_ranking_occurrence
    WHERE occurrence_key=NEW.occurrence_key
  );

  INSERT OR REPLACE INTO sh_track_ranking_current(
    track_identity,track_id,title,artist,isrc,spotify_id,
    latest_like_count,latest_observed_at,latest_occurrence_key
  )
  SELECT track_identity,track_id,title,artist,isrc,spotify_id,
    latest_like_count,latest_observed_at,occurrence_key
  FROM (
    SELECT occurrence.*
    FROM sh_track_ranking_occurrence occurrence
    WHERE occurrence.track_identity=(
      SELECT track_identity FROM sh_track_ranking_occurrence
      WHERE occurrence_key=NEW.occurrence_key
    )
    ORDER BY occurrence.latest_observed_at DESC,occurrence.occurrence_key DESC
    LIMIT 1
  ) latest
  WHERE latest_like_count>0;
END;

DROP TRIGGER IF EXISTS trg_sh_track_ranking_current_after_counter_update;
CREATE TRIGGER trg_sh_track_ranking_current_after_counter_update
AFTER UPDATE OF track_id,isrc,spotify_id,track_key,count_value,observed_at
ON sh_track_counter_current
BEGIN
  -- Repair the previous identity while the occurrence map still contains OLD.
  DELETE FROM sh_track_ranking_current
  WHERE track_identity=(
    SELECT track_identity FROM sh_track_ranking_occurrence
    WHERE occurrence_key=NEW.occurrence_key
  );

  INSERT OR REPLACE INTO sh_track_ranking_current(
    track_identity,track_id,title,artist,isrc,spotify_id,
    latest_like_count,latest_observed_at,latest_occurrence_key
  )
  SELECT track_identity,track_id,title,artist,isrc,spotify_id,
    latest_like_count,latest_observed_at,occurrence_key
  FROM (
    SELECT occurrence.*
    FROM sh_track_ranking_occurrence occurrence
    WHERE occurrence.track_identity=(
        SELECT track_identity FROM sh_track_ranking_occurrence
        WHERE occurrence_key=NEW.occurrence_key
      )
      AND occurrence.occurrence_key<>NEW.occurrence_key
    ORDER BY occurrence.latest_observed_at DESC,occurrence.occurrence_key DESC
    LIMIT 1
  ) latest
  WHERE latest_like_count>0;

  DELETE FROM sh_track_ranking_occurrence
  WHERE occurrence_key=NEW.occurrence_key;

  INSERT OR REPLACE INTO sh_track_ranking_occurrence(
    occurrence_key,track_identity,track_id,title,artist,isrc,spotify_id,
    latest_like_count,latest_observed_at
  )
  SELECT occurrence_key,track_identity,resolved_track_id,title,artist,isrc,spotify_id,
    count_value,observed_at
  FROM sh_track_ranking_candidates
  WHERE occurrence_key=NEW.occurrence_key;

  -- Repair the new identity. If NEW became ineligible there is no new map row.
  DELETE FROM sh_track_ranking_current
  WHERE track_identity=(
    SELECT track_identity FROM sh_track_ranking_occurrence
    WHERE occurrence_key=NEW.occurrence_key
  );

  INSERT OR REPLACE INTO sh_track_ranking_current(
    track_identity,track_id,title,artist,isrc,spotify_id,
    latest_like_count,latest_observed_at,latest_occurrence_key
  )
  SELECT track_identity,track_id,title,artist,isrc,spotify_id,
    latest_like_count,latest_observed_at,occurrence_key
  FROM (
    SELECT occurrence.*
    FROM sh_track_ranking_occurrence occurrence
    WHERE occurrence.track_identity=(
      SELECT track_identity FROM sh_track_ranking_occurrence
      WHERE occurrence_key=NEW.occurrence_key
    )
    ORDER BY occurrence.latest_observed_at DESC,occurrence.occurrence_key DESC
    LIMIT 1
  ) latest
  WHERE latest_like_count>0;
END;

-- Track metadata changes are rare and are eventually reflected by the next
-- counter update. Avoid a global counter scan on every dictionary write.

ANALYZE sh_minute_fact_jobs;
ANALYZE sh_queue_revisions;
ANALYZE sh_track_ranking_occurrence;
ANALYZE sh_track_ranking_current;
PRAGMA optimize;
