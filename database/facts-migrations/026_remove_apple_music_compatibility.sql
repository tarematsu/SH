-- Remove the last Apple Music compatibility columns from the canonical facts
-- counter tables and source-shaped views. Spotify ID and ISRC remain the only
-- provider identity fields used by the runtime.

DROP VIEW IF EXISTS sh_queue_items;
DROP VIEW IF EXISTS sh_track_like_observations;
DROP VIEW IF EXISTS sh_track_like_current;
DROP TRIGGER IF EXISTS trg_sh_track_counter_current;

ALTER TABLE sh_track_counter_changes DROP COLUMN apple_music_id;
ALTER TABLE sh_track_counter_current DROP COLUMN apple_music_id;

CREATE TRIGGER trg_sh_track_counter_current
AFTER INSERT ON sh_track_counter_changes
BEGIN
  INSERT INTO sh_track_counter_current(
    occurrence_key,station_id,queue_id,queue_start_time,queue_position,
    queue_track_id,stationhead_track_id,spotify_id,isrc,
    track_key,track_id,queue_revision_id,count_value,observed_at,change_id
  ) VALUES(
    NEW.occurrence_key,NEW.station_id,NEW.queue_id,NEW.queue_start_time,NEW.queue_position,
    NEW.queue_track_id,NEW.stationhead_track_id,NEW.spotify_id,NEW.isrc,
    NEW.track_key,NEW.track_id,NEW.queue_revision_id,NEW.count_value,NEW.observed_at,NEW.id
  ) ON CONFLICT(occurrence_key) DO UPDATE SET
    station_id=excluded.station_id,queue_id=excluded.queue_id,
    queue_start_time=excluded.queue_start_time,queue_position=excluded.queue_position,
    queue_track_id=excluded.queue_track_id,stationhead_track_id=excluded.stationhead_track_id,
    spotify_id=excluded.spotify_id,isrc=excluded.isrc,
    track_key=excluded.track_key,track_id=excluded.track_id,
    queue_revision_id=excluded.queue_revision_id,count_value=excluded.count_value,
    observed_at=excluded.observed_at,change_id=excluded.change_id
  WHERE excluded.observed_at>=sh_track_counter_current.observed_at;
END;

CREATE VIEW sh_queue_items AS
WITH ranked_revisions AS (
  SELECT r.*,
    ROW_NUMBER() OVER (
      PARTITION BY r.channel_id,COALESCE(r.station_id,-1),r.queue_start_time
      ORDER BY r.effective_at DESC,r.id DESC
    ) AS revision_rank
  FROM sh_queue_revisions r
  WHERE r.status='complete'
    AND r.queue_start_time IS NOT NULL
)
SELECT CAST(r.id*1000000+i.position AS INTEGER) AS id,
  r.effective_at AS observed_at,
  r.station_id,
  r.queue_id,
  r.queue_start_time AS start_time,
  i.position,
  i.queue_track_id,
  i.stationhead_track_id,
  i.spotify_id,
  i.deezer_id,
  i.isrc,
  i.duration_ms,
  NULL AS preview_url,
  COALESCE((
    SELECT cc.count_value
    FROM sh_track_counter_changes cc
    WHERE cc.occurrence_key='revision:'||CAST(r.id AS TEXT)||':'||CAST(i.position AS TEXT)
    ORDER BY cc.observed_at DESC,cc.id DESC
    LIMIT 1
  ),i.bite_count) AS bite_count,
  NULL AS raw_json
FROM ranked_revisions r
JOIN sh_queue_revision_items i ON i.revision_id=r.id
WHERE r.revision_rank=1;

CREATE VIEW sh_track_like_observations AS
SELECT c.id AS source_id,c.id,c.observed_at,c.station_id,c.queue_id,
  c.queue_start_time AS start_time,c.queue_position AS position,c.queue_track_id,
  c.stationhead_track_id,c.spotify_id,c.isrc,
  c.track_key,c.count_value AS like_count,c.source,NULL AS raw_json
FROM sh_track_counter_changes c;

CREATE VIEW sh_track_like_current AS
WITH ranked AS (
  SELECT c.*,
    ROW_NUMBER() OVER(PARTITION BY c.station_id,c.track_key
      ORDER BY c.observed_at DESC,c.change_id DESC) AS row_rank
  FROM sh_track_counter_current c
)
SELECT station_id,track_key,queue_id,queue_start_time AS start_time,queue_position AS position,
  queue_track_id,stationhead_track_id,spotify_id,isrc,
  count_value AS like_count,observed_at
FROM ranked WHERE row_rank=1;

PRAGMA optimize;
