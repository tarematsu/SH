UPDATE sh_track_metadata AS target
SET artist = (
  SELECT source.artist
  FROM sh_queue_items AS target_q
  JOIN sh_queue_items AS source_q
    ON source_q.isrc = target_q.isrc
   AND source_q.isrc IS NOT NULL
   AND source_q.isrc <> ''
  JOIN sh_track_metadata AS source
    ON source.spotify_id = source_q.spotify_id
  WHERE target_q.spotify_id = target.spotify_id
    AND source.artist IS NOT NULL
    AND TRIM(source.artist) <> ''
    AND source.artist <> '-'
  ORDER BY source.fetched_at DESC
  LIMIT 1
)
WHERE (target.artist IS NULL OR TRIM(target.artist) = '' OR target.artist = '-')
  AND EXISTS (
    SELECT 1
    FROM sh_queue_items AS target_q
    JOIN sh_queue_items AS source_q
      ON source_q.isrc = target_q.isrc
     AND source_q.isrc IS NOT NULL
     AND source_q.isrc <> ''
    JOIN sh_track_metadata AS source
      ON source.spotify_id = source_q.spotify_id
    WHERE target_q.spotify_id = target.spotify_id
      AND source.artist IS NOT NULL
      AND TRIM(source.artist) <> ''
      AND source.artist <> '-'
  );
