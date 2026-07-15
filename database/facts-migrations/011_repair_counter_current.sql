-- Repair the current counter projection after the initial counter-log cutover.
-- The first cutover rebuilt this table by maximum row id, which is not a safe
-- proxy for the newest observation when a delayed row is imported.

CREATE TABLE IF NOT EXISTS sh_facts_storage_repairs (
  repair_key TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

DELETE FROM sh_track_counter_current
WHERE NOT EXISTS (
  SELECT 1 FROM sh_facts_storage_repairs
  WHERE repair_key='011_repair_counter_current'
);

INSERT INTO sh_track_counter_current(
  occurrence_key,station_id,queue_id,queue_start_time,queue_position,
  queue_track_id,stationhead_track_id,spotify_id,apple_music_id,isrc,track_key,
  track_id,queue_revision_id,count_value,observed_at,change_id
)
SELECT c.occurrence_key,c.station_id,c.queue_id,c.queue_start_time,c.queue_position,
  c.queue_track_id,c.stationhead_track_id,c.spotify_id,c.apple_music_id,c.isrc,
  c.track_key,c.track_id,c.queue_revision_id,c.count_value,c.observed_at,c.id
FROM sh_track_counter_changes c
JOIN (
  SELECT id FROM (
    SELECT id,ROW_NUMBER() OVER(
      PARTITION BY occurrence_key ORDER BY observed_at DESC,id DESC
    ) AS row_rank
    FROM sh_track_counter_changes
  ) ranked WHERE row_rank=1
) latest ON latest.id=c.id
WHERE NOT EXISTS (
  SELECT 1 FROM sh_facts_storage_repairs
  WHERE repair_key='011_repair_counter_current'
);

INSERT OR IGNORE INTO sh_facts_storage_repairs(repair_key,applied_at)
VALUES('011_repair_counter_current',CAST(strftime('%s','now') AS INTEGER)*1000);

PRAGMA optimize;
