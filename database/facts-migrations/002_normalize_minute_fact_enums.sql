-- One-time migration: replace sh_minute_facts.source / track_detection_method
-- (free-text TEXT columns) with dictionary-coded INTEGER columns
-- (source_code / track_detection_code). SQLite cannot ALTER a column's type,
-- so this rebuilds the table under a temporary name and swaps it in.
--
-- This file is applied exactly once by worker/scripts/provision-facts-db.mjs,
-- which checks for the presence of the source_code column before running it.
-- It is NOT re-applied on every push like 001_initial_schema.sql, so it does
-- not need to tolerate being run against an already-migrated table.
PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS sh_minute_facts_v2;

CREATE TABLE sh_minute_facts_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  station_id INTEGER,
  minute_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  source_code INTEGER NOT NULL,
  source_priority INTEGER NOT NULL,
  source_record_id TEXT,
  collector_id TEXT,
  broadcast_session_id INTEGER,
  host_id INTEGER,
  is_broadcasting INTEGER,
  broadcast_start_time INTEGER,
  listener_count INTEGER,
  online_member_count INTEGER,
  total_member_count INTEGER,
  guest_count INTEGER,
  reported_total_listens INTEGER,
  reported_current_stream_count INTEGER,
  validated_stream_count INTEGER,
  stream_count_rejected INTEGER NOT NULL DEFAULT 0,
  queue_revision_id INTEGER,
  queue_id INTEGER,
  queue_start_time INTEGER,
  is_paused INTEGER NOT NULL DEFAULT 0,
  queue_track_count INTEGER,
  queue_available INTEGER NOT NULL DEFAULT 0,
  track_id INTEGER,
  queue_position INTEGER,
  track_detection_code INTEGER NOT NULL,
  track_confidence REAL,
  schedule_valid INTEGER NOT NULL DEFAULT 0,
  track_bite_count INTEGER,
  comment_count INTEGER,
  comment_total INTEGER,
  comments_degraded INTEGER NOT NULL DEFAULT 0,
  quality_score REAL NOT NULL DEFAULT 1,
  quality_flags INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(broadcast_session_id) REFERENCES sh_broadcast_sessions(id),
  FOREIGN KEY(host_id) REFERENCES sh_hosts(id),
  FOREIGN KEY(queue_revision_id) REFERENCES sh_queue_revisions(id),
  FOREIGN KEY(track_id) REFERENCES sh_tracks(id),
  UNIQUE(channel_id, minute_at)
);

-- Source codes: 1=live_collector 2=live_reconstructed 3=legacy_normalized 4=legacy_raw
-- Track detection codes: 0=unknown 1=queue_inferred 2=queue_reconstructed
INSERT INTO sh_minute_facts_v2(
  id,channel_id,station_id,minute_at,observed_at,received_at,source_code,source_priority,
  source_record_id,collector_id,broadcast_session_id,host_id,is_broadcasting,broadcast_start_time,
  listener_count,online_member_count,total_member_count,guest_count,reported_total_listens,
  reported_current_stream_count,validated_stream_count,stream_count_rejected,queue_revision_id,
  queue_id,queue_start_time,is_paused,queue_track_count,queue_available,track_id,queue_position,
  track_detection_code,track_confidence,schedule_valid,track_bite_count,comment_count,comment_total,
  comments_degraded,quality_score,quality_flags
)
SELECT
  id,channel_id,station_id,minute_at,observed_at,received_at,
  CASE source
    WHEN 'live_collector' THEN 1
    WHEN 'live_reconstructed' THEN 2
    WHEN 'legacy_normalized' THEN 3
    WHEN 'legacy_raw' THEN 4
    ELSE 1
  END,
  source_priority,source_record_id,collector_id,broadcast_session_id,host_id,is_broadcasting,
  broadcast_start_time,listener_count,online_member_count,total_member_count,guest_count,
  reported_total_listens,reported_current_stream_count,validated_stream_count,stream_count_rejected,
  queue_revision_id,queue_id,queue_start_time,is_paused,queue_track_count,queue_available,track_id,
  queue_position,
  CASE track_detection_method
    WHEN 'unknown' THEN 0
    WHEN 'queue_inferred' THEN 1
    WHEN 'queue_reconstructed' THEN 2
    ELSE 0
  END,
  track_confidence,schedule_valid,track_bite_count,comment_count,comment_total,comments_degraded,
  quality_score,quality_flags
FROM sh_minute_facts;

DROP TABLE sh_minute_facts;
ALTER TABLE sh_minute_facts_v2 RENAME TO sh_minute_facts;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sh_minute_facts_source_record
  ON sh_minute_facts(source_code, source_record_id)
  WHERE source_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sh_minute_facts_time ON sh_minute_facts(minute_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_minute_facts_track_time ON sh_minute_facts(track_id, minute_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_minute_facts_host_time ON sh_minute_facts(host_id, minute_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_minute_facts_session_time ON sh_minute_facts(broadcast_session_id, minute_at);
