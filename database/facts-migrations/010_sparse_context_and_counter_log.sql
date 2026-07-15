-- Sparse member totals, normalized minute context, canonical queue views and
-- one append-only counter log.  This migration is intentionally additive at
-- the API boundary: the old source-shaped names remain compatibility views.

PRAGMA foreign_keys = ON;
PRAGMA defer_foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sh_total_member_daily (
  channel_id INTEGER NOT NULL,
  day_at INTEGER NOT NULL,
  host_key INTEGER NOT NULL DEFAULT 0,
  host_id INTEGER,
  first_observed_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  first_total_member_count INTEGER NOT NULL CHECK(first_total_member_count >= 0),
  last_total_member_count INTEGER NOT NULL CHECK(last_total_member_count >= 0),
  min_total_member_count INTEGER NOT NULL CHECK(min_total_member_count >= 0),
  max_total_member_count INTEGER NOT NULL CHECK(max_total_member_count >= 0),
  source_code INTEGER NOT NULL,
  source_priority INTEGER NOT NULL,
  quality_score_code INTEGER NOT NULL DEFAULT 100,
  PRIMARY KEY(channel_id, day_at, host_key),
  FOREIGN KEY(host_id) REFERENCES sh_hosts(id),
  CHECK(host_key=COALESCE(host_id,0))
);
CREATE INDEX IF NOT EXISTS idx_sh_total_member_daily_channel_time
  ON sh_total_member_daily(channel_id,day_at DESC,host_key);

ALTER TABLE sh_queue_revisions ADD COLUMN revision_key TEXT;
UPDATE sh_queue_revisions SET revision_key=
  CAST(channel_id AS TEXT)||':'||COALESCE(CAST(session_id AS TEXT),'0')||':'||
  COALESCE(CAST(queue_id AS TEXT),'0')||':'||COALESCE(CAST(queue_start_time AS TEXT),'0')||':'||structural_hash
WHERE revision_key IS NULL;
CREATE INDEX IF NOT EXISTS idx_sh_queue_revisions_revision_key
  ON sh_queue_revisions(revision_key);

INSERT OR IGNORE INTO sh_total_member_daily(
  channel_id,day_at,host_key,host_id,first_observed_at,last_observed_at,
  first_total_member_count,last_total_member_count,min_total_member_count,
  max_total_member_count,source_code,source_priority,quality_score_code
)
SELECT channel_id,
  (observed_at/86400000)*86400000 AS day_at,
  0, NULL,
  MIN(observed_at),MAX(observed_at),
  MIN(total_member_count),MAX(total_member_count),
  MIN(total_member_count),MAX(total_member_count),
  1,100,100
FROM sh_minute_facts
WHERE total_member_count IS NOT NULL
GROUP BY channel_id,(observed_at/86400000)*86400000;

-- Keep only rare source overrides and the fact-to-queue-position link.  The
-- old table is removed after the values needed by the compatibility view have
-- been normalized; queue identity/items are derived from the canonical
-- revision tables below.
DROP VIEW IF EXISTS sh_channel_snapshots;
ALTER TABLE sh_minute_fact_context RENAME TO sh_minute_fact_context_legacy;

CREATE TABLE sh_minute_fact_context_v2 (
  fact_id INTEGER PRIMARY KEY,
  station_id_override INTEGER,
  host_id_override INTEGER,
  broadcast_start_time_override INTEGER,
  queue_revision_id INTEGER,
  queue_available INTEGER NOT NULL DEFAULT 0,
  queue_position INTEGER,
  FOREIGN KEY(fact_id) REFERENCES sh_minute_facts(id) ON DELETE CASCADE,
  FOREIGN KEY(host_id_override) REFERENCES sh_hosts(id),
  FOREIGN KEY(queue_revision_id) REFERENCES sh_queue_revisions(id)
);

INSERT INTO sh_minute_fact_context_v2(
  fact_id,station_id_override,host_id_override,broadcast_start_time_override,
  queue_revision_id,queue_available,queue_position
)
SELECT c.fact_id,
  CASE WHEN f.broadcast_session_id IS NULL
    OR c.station_id IS NOT (SELECT station_id FROM sh_broadcast_sessions s WHERE s.id=f.broadcast_session_id)
    THEN c.station_id END,
  CASE WHEN f.broadcast_session_id IS NULL
    OR c.host_id IS NOT (SELECT host_id FROM sh_broadcast_sessions s WHERE s.id=f.broadcast_session_id)
    THEN c.host_id END,
  CASE WHEN f.broadcast_session_id IS NULL
    OR c.broadcast_start_time IS NOT (SELECT broadcast_start_time FROM sh_broadcast_sessions s WHERE s.id=f.broadcast_session_id)
    THEN c.broadcast_start_time END,
  c.queue_revision_id,c.queue_available,c.queue_position
FROM sh_minute_fact_context_legacy c
JOIN sh_minute_facts f ON f.id=c.fact_id;

DROP TABLE sh_minute_fact_context_legacy;

CREATE TABLE IF NOT EXISTS sh_track_counter_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at INTEGER NOT NULL,
  occurrence_key TEXT NOT NULL,
  channel_id INTEGER,
  station_id INTEGER,
  queue_id INTEGER,
  queue_start_time INTEGER,
  queue_position INTEGER,
  queue_track_id INTEGER,
  stationhead_track_id INTEGER,
  spotify_id TEXT,
  apple_music_id TEXT,
  isrc TEXT,
  queue_revision_id INTEGER,
  track_id INTEGER,
  track_key TEXT NOT NULL,
  count_value INTEGER NOT NULL CHECK(count_value >= 0),
  previous_count_value INTEGER,
  source TEXT NOT NULL,
  source_record_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sh_counter_changes_source
  ON sh_track_counter_changes(source,source_record_id)
  WHERE source_record_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sh_counter_changes_event
  ON sh_track_counter_changes(occurrence_key,observed_at,count_value);
CREATE INDEX IF NOT EXISTS idx_sh_counter_changes_occurrence_time
  ON sh_track_counter_changes(occurrence_key,observed_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_sh_counter_changes_track_time
  ON sh_track_counter_changes(track_key,observed_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_sh_counter_changes_time
  ON sh_track_counter_changes(observed_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS sh_track_counter_current (
  occurrence_key TEXT PRIMARY KEY,
  station_id INTEGER,
  queue_id INTEGER,
  queue_start_time INTEGER,
  queue_position INTEGER,
  queue_track_id INTEGER,
  stationhead_track_id INTEGER,
  spotify_id TEXT,
  apple_music_id TEXT,
  isrc TEXT,
  track_key TEXT NOT NULL,
  track_id INTEGER,
  queue_revision_id INTEGER,
  count_value INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  change_id INTEGER NOT NULL,
  FOREIGN KEY(change_id) REFERENCES sh_track_counter_changes(id)
);
CREATE INDEX IF NOT EXISTS idx_sh_counter_current_station_track
  ON sh_track_counter_current(station_id,track_key,observed_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_sh_track_counter_current
AFTER INSERT ON sh_track_counter_changes
BEGIN
  INSERT INTO sh_track_counter_current(
    occurrence_key,station_id,queue_id,queue_start_time,queue_position,
    queue_track_id,stationhead_track_id,spotify_id,apple_music_id,isrc,
    track_key,track_id,queue_revision_id,count_value,observed_at,change_id
  ) VALUES(
    NEW.occurrence_key,NEW.station_id,NEW.queue_id,NEW.queue_start_time,NEW.queue_position,
    NEW.queue_track_id,NEW.stationhead_track_id,NEW.spotify_id,NEW.apple_music_id,NEW.isrc,
    NEW.track_key,NEW.track_id,NEW.queue_revision_id,NEW.count_value,NEW.observed_at,NEW.id
  ) ON CONFLICT(occurrence_key) DO UPDATE SET
    station_id=excluded.station_id,queue_id=excluded.queue_id,
    queue_start_time=excluded.queue_start_time,queue_position=excluded.queue_position,
    queue_track_id=excluded.queue_track_id,stationhead_track_id=excluded.stationhead_track_id,
    spotify_id=excluded.spotify_id,apple_music_id=excluded.apple_music_id,isrc=excluded.isrc,
    track_key=excluded.track_key,track_id=excluded.track_id,
    queue_revision_id=excluded.queue_revision_id,count_value=excluded.count_value,
    observed_at=excluded.observed_at,change_id=excluded.change_id
  WHERE excluded.observed_at>=sh_track_counter_current.observed_at;
END;

-- Import both old interpretations once, de-duplicating the same observed
-- counter.  Future writes use only sh_track_counter_changes.
INSERT OR IGNORE INTO sh_track_counter_changes(
  observed_at,occurrence_key,channel_id,station_id,queue_id,queue_start_time,
  queue_position,queue_track_id,stationhead_track_id,spotify_id,apple_music_id,isrc,
  queue_revision_id,track_id,track_key,count_value,
  previous_count_value,source,source_record_id
)
WITH legacy_like AS (
  SELECT o.*,
    COALESCE(CAST(station_id AS TEXT),'0')||':'||COALESCE(CAST(queue_id AS TEXT),'0')||':'||
      COALESCE(CAST(start_time AS TEXT),'0')||':'||COALESCE(CAST(position AS TEXT),track_key)
      AS occurrence_key
  FROM sh_track_like_observations o WHERE like_count IS NOT NULL
), ordered_like AS (
  SELECT l.*,LAG(like_count) OVER(
    PARTITION BY occurrence_key ORDER BY observed_at,source_id
  ) AS previous_count
  FROM legacy_like l
)
SELECT observed_at,occurrence_key,NULL,station_id,queue_id,start_time,position,
  queue_track_id,stationhead_track_id,spotify_id,apple_music_id,isrc,NULL,NULL,
  track_key,like_count,previous_count,source,'like:'||CAST(source_id AS TEXT)
FROM ordered_like
WHERE previous_count IS NULL OR previous_count IS NOT like_count;

INSERT OR IGNORE INTO sh_track_counter_changes(
  observed_at,occurrence_key,channel_id,station_id,queue_id,queue_start_time,
  queue_position,queue_revision_id,track_id,track_key,count_value,
  previous_count_value,source,source_record_id
)
WITH legacy_bite AS (
  SELECT b.*,
    'revision:'||COALESCE(CAST(b.revision_id AS TEXT),'0')||':'||
      COALESCE(CAST(b.queue_position AS TEXT),'0') AS occurrence_key
  FROM sh_track_bite_observations b WHERE b.bite_count IS NOT NULL
), ordered_bite AS (
  SELECT b.*,LAG(bite_count) OVER(
    PARTITION BY occurrence_key ORDER BY observed_at,id
  ) AS previous_count
  FROM legacy_bite b
)
SELECT observed_at,occurrence_key,channel_id,station_id,NULL,NULL,queue_position,
  revision_id,track_id,COALESCE(CAST(track_id AS TEXT),'unknown'),bite_count,
  previous_count,source,'bite:'||CAST(id AS TEXT)
FROM ordered_bite
WHERE previous_count IS NULL OR previous_count IS NOT bite_count;

INSERT OR REPLACE INTO sh_track_counter_current(
  occurrence_key,station_id,queue_id,queue_start_time,queue_position,
  queue_track_id,stationhead_track_id,spotify_id,apple_music_id,isrc,track_key,
  track_id,queue_revision_id,count_value,observed_at,change_id
)
SELECT c.occurrence_key,c.station_id,c.queue_id,c.queue_start_time,c.queue_position,
  c.queue_track_id,c.stationhead_track_id,c.spotify_id,c.apple_music_id,c.isrc,
  c.track_key,c.track_id,c.queue_revision_id,c.count_value,c.observed_at,c.id
FROM sh_track_counter_changes c
JOIN (
  SELECT occurrence_key,MAX(id) AS id
  FROM sh_track_counter_changes GROUP BY occurrence_key
) latest ON latest.id=c.id;

DROP VIEW IF EXISTS sh_queue_items;
DROP VIEW IF EXISTS sh_track_like_current;
DROP TABLE IF EXISTS sh_queue_item_observations;
DROP TABLE IF EXISTS sh_track_like_observations;
DROP TABLE IF EXISTS sh_track_bite_observations;
DELETE FROM sh_buddies_sync_state WHERE sync_key='queue-items';

-- Canonical queue read model: revisions/items are the only durable queue
-- observation.  Compatibility consumers keep the old source-shaped columns.
CREATE VIEW sh_queue_items AS
SELECT CAST(r.id*1000000+i.position AS INTEGER) AS id,
  r.effective_at AS observed_at,r.station_id,r.queue_id,
  r.queue_start_time AS start_time,i.position,i.queue_track_id,
  i.stationhead_track_id,i.spotify_id,NULL AS apple_music_id,i.deezer_id,i.isrc,
  i.duration_ms,NULL AS preview_url,
  COALESCE((SELECT cc.count_value FROM sh_track_counter_changes cc
    WHERE cc.occurrence_key='revision:'||CAST(r.id AS TEXT)||':'||CAST(i.position AS TEXT)
    ORDER BY cc.observed_at DESC,cc.id DESC LIMIT 1),i.bite_count) AS bite_count,
  NULL AS raw_json
FROM sh_queue_revisions r
JOIN sh_queue_revision_items i ON i.revision_id=r.id
WHERE r.status='complete';

CREATE VIEW sh_track_like_observations AS
SELECT c.id AS source_id,c.id,c.observed_at,c.station_id,c.queue_id,
  c.queue_start_time AS start_time,c.queue_position AS position,c.queue_track_id,
  c.stationhead_track_id,c.spotify_id,c.apple_music_id,c.isrc,
  c.track_key,c.count_value AS like_count,c.source,NULL AS raw_json
FROM sh_track_counter_changes c;

CREATE VIEW sh_track_bite_observations AS
SELECT id,observed_at,channel_id,station_id,queue_revision_id AS revision_id,
  track_id,queue_position,count_value AS bite_count,source
FROM sh_track_counter_changes;

CREATE VIEW sh_track_like_current AS
WITH ranked AS (
  SELECT c.*,
    ROW_NUMBER() OVER(PARTITION BY c.station_id,c.track_key
      ORDER BY c.observed_at DESC,c.change_id DESC) AS row_rank
  FROM sh_track_counter_current c
)
SELECT station_id,track_key,queue_id,queue_start_time AS start_time,queue_position AS position,
  queue_track_id,stationhead_track_id,spotify_id,apple_music_id,isrc,
  count_value AS like_count,observed_at
FROM ranked WHERE row_rank=1;

CREATE VIEW sh_minute_fact_context AS
SELECT v.fact_id,
  COALESCE(v.station_id_override,s.station_id) AS station_id,
  COALESCE(v.host_id_override,s.host_id) AS host_id,
  COALESCE(v.broadcast_start_time_override,s.broadcast_start_time) AS broadcast_start_time,
  v.queue_revision_id,r.queue_id,r.queue_start_time,r.item_count AS queue_track_count,
  v.queue_available,i.track_id,v.queue_position,
  COALESCE((SELECT cc.count_value FROM sh_track_counter_changes cc
    WHERE cc.occurrence_key='revision:'||CAST(v.queue_revision_id AS TEXT)||':'||CAST(v.queue_position AS TEXT)
    ORDER BY cc.observed_at DESC,cc.id DESC LIMIT 1),i.bite_count) AS track_bite_count
FROM sh_minute_fact_context_v2 v
LEFT JOIN sh_minute_facts f ON f.id=v.fact_id
LEFT JOIN sh_broadcast_sessions s ON s.id=f.broadcast_session_id
LEFT JOIN sh_queue_revisions r ON r.id=v.queue_revision_id
LEFT JOIN sh_queue_revision_items i
  ON i.revision_id=v.queue_revision_id AND i.position=v.queue_position;

CREATE VIEW sh_minute_fact_context_resolved AS
SELECT fact_id,station_id,host_id,broadcast_start_time
FROM sh_minute_fact_context;

CREATE VIEW sh_channel_snapshots AS
SELECT f.id,f.observed_at,f.channel_id,NULL AS channel_alias,NULL AS channel_name,
  c.station_id,f.is_broadcasting AS is_launched,f.is_broadcasting,
  NULL AS chat_status,f.listener_count,f.online_member_count,
  COALESCE((SELECT d.last_total_member_count FROM sh_total_member_daily d
    WHERE d.channel_id=f.channel_id AND d.day_at=(f.observed_at/86400000)*86400000
    ORDER BY d.last_observed_at DESC,d.host_key LIMIT 1),f.total_member_count) AS total_member_count,
  f.guest_count,f.reported_total_listens AS total_listens,NULL AS stream_goal,
  f.reported_current_stream_count AS current_stream_count,
  h.stationhead_account_id AS host_account_id,h.current_handle AS host_handle,
  c.broadcast_start_time,NULL AS raw_json,f.comment_count AS comment_velocity,
  NULL AS validated_stream_count
FROM sh_minute_facts f
LEFT JOIN sh_minute_fact_context c ON c.fact_id=f.id
LEFT JOIN sh_hosts h ON h.id=c.host_id;

DROP INDEX IF EXISTS idx_sh_queue_state_events_revision_time;
DROP INDEX IF EXISTS idx_sh_track_like_observations_station_track_time;
DROP INDEX IF EXISTS idx_sh_track_like_observations_time;
DROP INDEX IF EXISTS idx_sh_bites_track_time;
DROP INDEX IF EXISTS idx_sh_track_metadata_fetched_at;
CREATE INDEX IF NOT EXISTS idx_sh_track_metadata_fetched_spotify
  ON sh_track_metadata(fetched_at,spotify_id);
CREATE INDEX IF NOT EXISTS idx_sh_minute_facts_live_latest
  ON sh_minute_facts(minute_at DESC,id DESC) WHERE source_code=1;

-- From this point, total_member_count in minute facts is a compatibility
-- column.  Its canonical value is sh_total_member_daily.
UPDATE sh_minute_facts SET total_member_count=NULL;

PRAGMA optimize;
