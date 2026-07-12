-- One-time migration: compact and normalize sh_minute_facts.
--
-- The old table kept sparse session/queue/track context on every minute row,
-- repeated collector text, derived stream-validation values, and REAL scores.
-- Keep the fact id and natural key stable while moving sparse context to a
-- one-to-one table and dictionary-encoding the remaining repeated values.
-- This migration is applied by worker/scripts/provision-facts-db.mjs after the
-- source/track enum migration (002) has completed.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE sh_minute_fact_collectors (
  collector_code INTEGER PRIMARY KEY,
  collector_id TEXT NOT NULL UNIQUE
);

INSERT INTO sh_minute_fact_collectors(collector_code,collector_id) VALUES
  (1,'cloudflare-worker'),
  (2,'cloudflare-worker:rebuild'),
  (3,'legacy-migration');

CREATE TABLE sh_minute_facts_compact (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  minute_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  source_code INTEGER NOT NULL,
  source_priority INTEGER NOT NULL,
  source_record_id TEXT,
  collector_code INTEGER NOT NULL DEFAULT 0,
  broadcast_session_id INTEGER,
  is_broadcasting INTEGER,
  listener_count INTEGER,
  online_member_count INTEGER,
  total_member_count INTEGER,
  guest_count INTEGER,
  reported_total_listens INTEGER,
  reported_current_stream_count INTEGER,
  is_paused INTEGER NOT NULL DEFAULT 0,
  track_detection_code INTEGER NOT NULL,
  track_confidence_code INTEGER NOT NULL DEFAULT 0,
  schedule_valid INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER,
  comment_total INTEGER,
  comments_degraded INTEGER NOT NULL DEFAULT 0,
  quality_score_code INTEGER NOT NULL DEFAULT 100,
  quality_flags INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(broadcast_session_id) REFERENCES sh_broadcast_sessions(id),
  UNIQUE(channel_id, minute_at)
);

CREATE TABLE sh_minute_fact_context_compact (
  fact_id INTEGER PRIMARY KEY,
  station_id INTEGER,
  host_id INTEGER,
  broadcast_start_time INTEGER,
  queue_revision_id INTEGER,
  queue_id INTEGER,
  queue_start_time INTEGER,
  queue_track_count INTEGER,
  queue_available INTEGER NOT NULL DEFAULT 0,
  track_id INTEGER,
  queue_position INTEGER,
  track_bite_count INTEGER
);

INSERT INTO sh_minute_facts_compact(
  id,channel_id,minute_at,observed_at,received_at,source_code,source_priority,
  source_record_id,collector_code,broadcast_session_id,is_broadcasting,
  listener_count,online_member_count,total_member_count,guest_count,
  reported_total_listens,reported_current_stream_count,is_paused,
  track_detection_code,track_confidence_code,schedule_valid,comment_count,
  comment_total,comments_degraded,quality_score_code,quality_flags
)
SELECT
  id,channel_id,minute_at,observed_at,received_at,source_code,source_priority,
  source_record_id,
  CASE collector_id
    WHEN 'cloudflare-worker' THEN 1
    WHEN 'cloudflare-worker:rebuild' THEN 2
    WHEN 'legacy-migration' THEN 3
    ELSE 0
  END,
  broadcast_session_id,is_broadcasting,
  listener_count,online_member_count,total_member_count,guest_count,
  reported_total_listens,reported_current_stream_count,is_paused,
  track_detection_code,
  CAST(MIN(100,MAX(0,ROUND(COALESCE(track_confidence,0)*100))) AS INTEGER),
  schedule_valid,comment_count,comment_total,comments_degraded,
  CAST(MIN(100,MAX(0,ROUND(COALESCE(quality_score,1)*100))) AS INTEGER),
  quality_flags
FROM sh_minute_facts;

INSERT INTO sh_minute_fact_context_compact(
  fact_id,station_id,host_id,broadcast_start_time,queue_revision_id,queue_id,
  queue_start_time,queue_track_count,queue_available,track_id,queue_position,
  track_bite_count
)
SELECT
  id,station_id,host_id,broadcast_start_time,queue_revision_id,queue_id,
  queue_start_time,queue_track_count,queue_available,track_id,queue_position,
  track_bite_count
FROM sh_minute_facts
WHERE station_id IS NOT NULL
   OR host_id IS NOT NULL
   OR broadcast_start_time IS NOT NULL
   OR queue_revision_id IS NOT NULL
   OR queue_id IS NOT NULL
   OR queue_start_time IS NOT NULL
   OR queue_track_count IS NOT NULL
   OR queue_available<>0
   OR track_id IS NOT NULL
   OR queue_position IS NOT NULL
   OR track_bite_count IS NOT NULL;

DROP TABLE sh_minute_facts;
ALTER TABLE sh_minute_facts_compact RENAME TO sh_minute_facts;

CREATE TABLE sh_minute_fact_context (
  fact_id INTEGER PRIMARY KEY,
  station_id INTEGER,
  host_id INTEGER,
  broadcast_start_time INTEGER,
  queue_revision_id INTEGER,
  queue_id INTEGER,
  queue_start_time INTEGER,
  queue_track_count INTEGER,
  queue_available INTEGER NOT NULL DEFAULT 0,
  track_id INTEGER,
  queue_position INTEGER,
  track_bite_count INTEGER,
  FOREIGN KEY(fact_id) REFERENCES sh_minute_facts(id) ON DELETE CASCADE,
  FOREIGN KEY(host_id) REFERENCES sh_hosts(id),
  FOREIGN KEY(queue_revision_id) REFERENCES sh_queue_revisions(id),
  FOREIGN KEY(track_id) REFERENCES sh_tracks(id)
);

INSERT INTO sh_minute_fact_context(
  fact_id,station_id,host_id,broadcast_start_time,queue_revision_id,queue_id,
  queue_start_time,queue_track_count,queue_available,track_id,queue_position,
  track_bite_count
)
SELECT
  fact_id,station_id,host_id,broadcast_start_time,queue_revision_id,queue_id,
  queue_start_time,queue_track_count,queue_available,track_id,queue_position,
  track_bite_count
FROM sh_minute_fact_context_compact;

DROP TABLE sh_minute_fact_context_compact;

CREATE UNIQUE INDEX idx_sh_minute_facts_source_record
  ON sh_minute_facts(source_code, source_record_id)
  WHERE source_record_id IS NOT NULL;
CREATE INDEX idx_sh_minute_facts_time
  ON sh_minute_facts(minute_at ASC, id ASC);
