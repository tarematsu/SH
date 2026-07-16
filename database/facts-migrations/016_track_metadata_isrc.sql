-- Align the MINUTE database track metadata cache with the collector metadata
-- schema. Committed minute-fact enrichment reads and writes ISRC alongside the
-- Spotify identifier, so deployments missing this column fail after the Queue
-- job has otherwise committed successfully.

ALTER TABLE sh_track_metadata ADD COLUMN isrc TEXT;

CREATE INDEX IF NOT EXISTS idx_sh_track_metadata_isrc
  ON sh_track_metadata(isrc)
  WHERE isrc IS NOT NULL AND TRIM(isrc)<>'';
