-- Remove collection surfaces retired after the Sakurazaka monitor split.
-- Solo chat is represented by sh_solo_activity_* counts, current playback is
-- served by the dashboard read model, and profile values are session aggregates.

DROP TABLE IF EXISTS sh_host_comments;
DROP TABLE IF EXISTS sh_host_raw_events;
DROP TABLE IF EXISTS sh_host_profile_snapshots;

DROP TABLE IF EXISTS sh_buddy_playback_pipeline;
DROP TABLE IF EXISTS sh_buddy_playback_clock;
DROP TABLE IF EXISTS sh_buddy_track_metadata;
DROP TABLE IF EXISTS sh_playback_channel_current;

DELETE FROM sh_worker_collector_state WHERE id='buddy46';
DELETE FROM sh_worker_auth_control WHERE id='buddy46';
DELETE FROM sh_cloud_host_monitor_state WHERE id LIKE 'profile:%';

-- The dedicated Sakurazaka worker owns its own authentication row.
INSERT OR IGNORE INTO sh_worker_auth_control(id,lock_until,updated_at)
VALUES('sakurazaka46jp',0,0);

ALTER TABLE sh_host_queue_items DROP COLUMN apple_music_id;

PRAGMA optimize;
