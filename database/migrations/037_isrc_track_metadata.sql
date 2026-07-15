ALTER TABLE sh_track_metadata ADD COLUMN isrc TEXT;

UPDATE sh_track_metadata
SET isrc = (
  SELECT UPPER(TRIM(items.isrc))
  FROM sh_queue_items AS items
  WHERE items.spotify_id = sh_track_metadata.spotify_id
    AND items.isrc IS NOT NULL
    AND TRIM(items.isrc) <> ''
  ORDER BY items.observed_at DESC
  LIMIT 1
)
WHERE isrc IS NULL OR TRIM(isrc) = '';

CREATE INDEX IF NOT EXISTS idx_sh_track_metadata_isrc_fetched
  ON sh_track_metadata(isrc, fetched_at DESC)
  WHERE isrc IS NOT NULL AND isrc <> '';
