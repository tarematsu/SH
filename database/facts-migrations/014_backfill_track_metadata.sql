-- Fill missing or placeholder track display fields from the durable metadata
-- cache in the same MINUTE database. This migration is idempotent and only
-- replaces fields that are blank or known identity placeholders.

UPDATE sh_tracks
SET
  title = CASE
    WHEN title IS NULL OR TRIM(title) = '' OR title = spotify_id THEN
      COALESCE((
        SELECT NULLIF(TRIM(metadata.title), '')
        FROM sh_track_metadata AS metadata
        WHERE metadata.spotify_id = sh_tracks.spotify_id
        LIMIT 1
      ), title)
    ELSE title
  END,
  artist = CASE
    WHEN artist IS NULL OR TRIM(artist) = '' OR artist = spotify_id
      OR artist GLOB 'JP[A-Z0-9]*' THEN
      COALESCE((
        SELECT NULLIF(TRIM(metadata.artist), '')
        FROM sh_track_metadata AS metadata
        WHERE metadata.spotify_id = sh_tracks.spotify_id
        LIMIT 1
      ), artist)
    ELSE artist
  END
WHERE spotify_id IS NOT NULL
  AND TRIM(spotify_id) <> ''
  AND EXISTS (
    SELECT 1
    FROM sh_track_metadata AS metadata
    WHERE metadata.spotify_id = sh_tracks.spotify_id
      AND (
        NULLIF(TRIM(metadata.title), '') IS NOT NULL
        OR NULLIF(TRIM(metadata.artist), '') IS NOT NULL
      )
  );
