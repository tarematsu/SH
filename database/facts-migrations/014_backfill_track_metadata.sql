-- Fill missing or placeholder track display fields from durable metadata in the
-- MINUTE database and create the ISRC-keyed cache used for tracks that do not
-- have Spotify identifiers. Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS sh_isrc_metadata (
  isrc TEXT PRIMARY KEY,
  title TEXT,
  artist TEXT,
  source TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  raw_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_sh_isrc_metadata_incomplete
  ON sh_isrc_metadata(fetched_at)
  WHERE title IS NULL OR TRIM(title)='' OR artist IS NULL OR TRIM(artist)='';

UPDATE sh_tracks
SET
  title = CASE
    WHEN title IS NULL OR TRIM(title) = '' OR title = spotify_id THEN
      COALESCE((
        SELECT NULLIF(TRIM(metadata.title), '')
        FROM sh_track_metadata AS metadata
        WHERE metadata.spotify_id = sh_tracks.spotify_id
        LIMIT 1
      ), (
        SELECT NULLIF(TRIM(metadata.title), '')
        FROM sh_isrc_metadata AS metadata
        WHERE metadata.isrc = UPPER(REPLACE(sh_tracks.isrc, '-', ''))
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
      ), (
        SELECT NULLIF(TRIM(metadata.artist), '')
        FROM sh_isrc_metadata AS metadata
        WHERE metadata.isrc = UPPER(REPLACE(sh_tracks.isrc, '-', ''))
        LIMIT 1
      ), artist)
    ELSE artist
  END
WHERE EXISTS (
  SELECT 1
  FROM sh_track_metadata AS metadata
  WHERE metadata.spotify_id = sh_tracks.spotify_id
    AND (
      NULLIF(TRIM(metadata.title), '') IS NOT NULL
      OR NULLIF(TRIM(metadata.artist), '') IS NOT NULL
    )
) OR EXISTS (
  SELECT 1
  FROM sh_isrc_metadata AS metadata
  WHERE metadata.isrc = UPPER(REPLACE(sh_tracks.isrc, '-', ''))
    AND (
      NULLIF(TRIM(metadata.title), '') IS NOT NULL
      OR NULLIF(TRIM(metadata.artist), '') IS NOT NULL
    )
);
