CREATE TABLE IF NOT EXISTS sh_legacy_hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_key TEXT NOT NULL UNIQUE,
  handle TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sh_legacy_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_key TEXT NOT NULL UNIQUE,
  title TEXT,
  artist_name TEXT
);

CREATE TABLE IF NOT EXISTS sh_legacy_broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_key TEXT NOT NULL UNIQUE,
  event_name TEXT NOT NULL,
  host_id INTEGER
);

CREATE TABLE IF NOT EXISTS sh_legacy_samples (
  legacy_id INTEGER PRIMARY KEY,
  observed_at INTEGER NOT NULL,
  observed_jst TEXT NOT NULL,
  listener_count INTEGER,
  total_stream_count INTEGER,
  track_id INTEGER,
  likes INTEGER,
  comment_velocity REAL,
  host_id INTEGER,
  total_member_count INTEGER,
  broadcast_id INTEGER,
  quality_score REAL NOT NULL,
  quality_flags TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sh_legacy_samples_observed
  ON sh_legacy_samples(observed_at, legacy_id);
CREATE INDEX IF NOT EXISTS idx_sh_legacy_samples_host
  ON sh_legacy_samples(host_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_sh_legacy_samples_broadcast
  ON sh_legacy_samples(broadcast_id, observed_at);

DROP VIEW IF EXISTS sh_legacy_history_rows;
CREATE VIEW sh_legacy_history_rows AS
SELECT
  s.legacy_id AS id,
  s.observed_at,
  s.observed_jst,
  s.listener_count,
  s.total_stream_count,
  t.title AS track_title,
  t.artist_name,
  s.likes,
  s.comment_velocity,
  h.handle AS host_handle,
  s.total_member_count,
  b.event_name AS source_note,
  s.quality_score,
  s.quality_flags
FROM sh_legacy_samples s
LEFT JOIN sh_legacy_tracks t ON t.id=s.track_id
LEFT JOIN sh_legacy_hosts h ON h.id=s.host_id
LEFT JOIN sh_legacy_broadcasts b ON b.id=s.broadcast_id
UNION ALL
SELECT
  l.id,
  l.observed_at,
  l.observed_jst,
  l.listener_count,
  l.total_stream_count,
  l.track_title,
  l.artist_name,
  l.likes,
  l.comment_velocity,
  l.host_handle,
  l.total_member_count,
  l.source_note,
  l.quality_score,
  l.quality_flags
FROM sh_legacy_snapshots l
WHERE NOT EXISTS (
  SELECT 1 FROM sh_legacy_samples s WHERE s.legacy_id=l.id
);
