-- Canonicalize legacy observation identities once so the 30-minute track-likes
-- read can partition on the stored key instead of re-normalizing ISRC and
-- Spotify text for every historical row.

DELETE FROM sh_track_like_observations
WHERE id IN (
  SELECT id FROM (
    SELECT id,
      ROW_NUMBER() OVER (
        PARTITION BY observed_at,station_id,
          CASE
            WHEN isrc IS NOT NULL AND TRIM(isrc)<>''
              THEN 'isrc:'||UPPER(TRIM(isrc))
            WHEN spotify_id IS NOT NULL AND TRIM(spotify_id)<>''
              THEN 'spotify:'||TRIM(spotify_id)
            ELSE track_key
          END
        ORDER BY id DESC
      ) AS identity_rank
    FROM sh_track_like_observations
  ) ranked
  WHERE identity_rank>1
);

UPDATE sh_track_like_observations
SET track_key=CASE
  WHEN isrc IS NOT NULL AND TRIM(isrc)<>''
    THEN 'isrc:'||UPPER(TRIM(isrc))
  WHEN spotify_id IS NOT NULL AND TRIM(spotify_id)<>''
    THEN 'spotify:'||TRIM(spotify_id)
  ELSE track_key
END
WHERE track_key IS NOT CASE
  WHEN isrc IS NOT NULL AND TRIM(isrc)<>''
    THEN 'isrc:'||UPPER(TRIM(isrc))
  WHEN spotify_id IS NOT NULL AND TRIM(spotify_id)<>''
    THEN 'spotify:'||TRIM(spotify_id)
  ELSE track_key
END;

CREATE INDEX IF NOT EXISTS idx_sh_track_like_observations_time_track
  ON sh_track_like_observations(observed_at DESC,track_key,id DESC);

PRAGMA optimize;
