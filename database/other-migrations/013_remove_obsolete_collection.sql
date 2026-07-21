-- Remove collection surfaces retired after the Sakurazaka monitor split.
-- Detailed solo comments are represented by sh_solo_activity_* counts, and
-- current playback is served by the dashboard read model.

DROP TABLE IF EXISTS sh_host_comments;
DROP TABLE IF EXISTS sh_host_raw_events;

DROP TABLE IF EXISTS sh_buddy_playback_pipeline;
DROP TABLE IF EXISTS sh_buddy_playback_clock;
DROP TABLE IF EXISTS sh_buddy_track_metadata;
DROP TABLE IF EXISTS sh_playback_channel_current;

DELETE FROM sh_worker_collector_state WHERE id='buddy46';
DELETE FROM sh_worker_auth_control WHERE id='buddy46';
DELETE FROM sh_cloud_host_monitor_state WHERE id LIKE 'profile:%';
DELETE FROM sh_host_profile_snapshots
WHERE source_scope='profile_monitor' OR lower(handle)='sakuramankai';

-- The dedicated Sakurazaka worker owns its own auth state and keeps only
-- session-scoped profile samples.
INSERT OR IGNORE INTO sh_worker_auth_control(id,lock_until,updated_at)
VALUES('sakurazaka46jp',0,0);

ALTER TABLE sh_host_queue_items DROP COLUMN apple_music_id;

PRAGMA optimize;
