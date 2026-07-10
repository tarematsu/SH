DROP TRIGGER IF EXISTS trg_sh_channel_comment_velocity;

CREATE TABLE IF NOT EXISTS sh_solo_activity_state (
  session_id INTEGER PRIMARY KEY,
  station_id INTEGER,
  last_item_id INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  last_observed_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sh_solo_activity_minutes (
  session_id INTEGER NOT NULL,
  bucket_start INTEGER NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(session_id,bucket_start)
);

CREATE TABLE IF NOT EXISTS sh_solo_activity_days (
  session_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(session_id,day_key)
);

CREATE TABLE IF NOT EXISTS sh_solo_activity_migration (
  id INTEGER PRIMARY KEY CHECK(id=1),
  migrated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO sh_solo_activity_migration(id,migrated_at) VALUES(1,0);

INSERT INTO sh_solo_activity_minutes(session_id,bucket_start,item_count)
SELECT session_id,
       CAST(COALESCE(chat_time_ms,chat_time*1000,observed_at)/60000 AS INTEGER)*60000,
       COUNT(*)
FROM sh_host_comments
WHERE (SELECT migrated_at FROM sh_solo_activity_migration WHERE id=1)=0
GROUP BY session_id,CAST(COALESCE(chat_time_ms,chat_time*1000,observed_at)/60000 AS INTEGER)
ON CONFLICT(session_id,bucket_start) DO UPDATE SET
  item_count=MAX(sh_solo_activity_minutes.item_count,excluded.item_count);

INSERT INTO sh_solo_activity_days(session_id,day_key,item_count)
SELECT session_id,
       date(COALESCE(chat_time_ms,chat_time*1000,observed_at)/1000,'unixepoch','+9 hours'),
       COUNT(*)
FROM sh_host_comments
WHERE (SELECT migrated_at FROM sh_solo_activity_migration WHERE id=1)=0
GROUP BY session_id,date(COALESCE(chat_time_ms,chat_time*1000,observed_at)/1000,'unixepoch','+9 hours')
ON CONFLICT(session_id,day_key) DO UPDATE SET
  item_count=MAX(sh_solo_activity_days.item_count,excluded.item_count);

INSERT INTO sh_solo_activity_state(
  session_id,station_id,last_item_id,total_count,last_observed_at
)
SELECT comments.session_id,MAX(comments.station_id),MAX(comments.comment_id),
       MAX(COALESCE(sessions.comment_count,0)),MAX(comments.observed_at)
FROM sh_host_comments comments
LEFT JOIN sh_host_broadcast_sessions sessions ON sessions.id=comments.session_id
WHERE (SELECT migrated_at FROM sh_solo_activity_migration WHERE id=1)=0
GROUP BY comments.session_id
ON CONFLICT(session_id) DO UPDATE SET
  station_id=COALESCE(excluded.station_id,sh_solo_activity_state.station_id),
  last_item_id=MAX(sh_solo_activity_state.last_item_id,excluded.last_item_id),
  total_count=MAX(sh_solo_activity_state.total_count,excluded.total_count),
  last_observed_at=MAX(sh_solo_activity_state.last_observed_at,excluded.last_observed_at);

UPDATE sh_host_broadcast_sessions
SET comment_count=COALESCE((
  SELECT total_count FROM sh_solo_activity_state
  WHERE session_id=sh_host_broadcast_sessions.id
),comment_count,0)
WHERE (SELECT migrated_at FROM sh_solo_activity_migration WHERE id=1)=0;

UPDATE sh_solo_activity_migration
SET migrated_at=CAST(unixepoch('now') AS INTEGER)*1000
WHERE id=1 AND migrated_at=0;
