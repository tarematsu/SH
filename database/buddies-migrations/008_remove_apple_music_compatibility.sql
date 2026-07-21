-- Spotify ID and ISRC are the only provider identities retained by the
-- collection buffer. Apple Music compatibility has no runtime consumer.

ALTER TABLE sh_queue_items DROP COLUMN apple_music_id;
ALTER TABLE sh_track_like_current DROP COLUMN apple_music_id;
ALTER TABLE sh_track_like_observations DROP COLUMN apple_music_id;

PRAGMA optimize;
