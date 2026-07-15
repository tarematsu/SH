-- The one-time copy into stationhead-buddies is performed by
-- consolidate-track-metadata.mjs before this cleanup migration is applied.
DROP TABLE IF EXISTS sh_track_metadata;
