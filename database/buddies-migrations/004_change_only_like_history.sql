-- BUDDIES is a 30-day recovery buffer.  Repeated observations with the same
-- counter value do not add recovery information; retain the first value for
-- each queue occurrence and every later value change.

DELETE FROM sh_track_like_observations
WHERE id IN (
  SELECT id FROM (
    SELECT id,like_count,
      LAG(like_count) OVER(
        PARTITION BY station_id,queue_id,start_time,position,track_key
        ORDER BY observed_at,id
      ) AS previous_like_count
    FROM sh_track_like_observations
  ) ordered
  WHERE previous_like_count IS like_count
);

CREATE INDEX IF NOT EXISTS idx_sh_track_like_observations_occurrence_time
  ON sh_track_like_observations(station_id,queue_id,start_time,position,observed_at DESC,id DESC);
