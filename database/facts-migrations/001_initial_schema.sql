PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sh_hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_key TEXT NOT NULL UNIQUE,
  stationhead_account_id INTEGER,
  current_handle TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sh_hosts_account
  ON sh_hosts(stationhead_account_id) WHERE stationhead_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sh_host_aliases (
  alias_type TEXT NOT NULL,
  alias_value TEXT NOT NULL,
  host_id INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY(alias_type, alias_value),
  FOREIGN KEY(host_id) REFERENCES sh_hosts(id)
);
CREATE INDEX IF NOT EXISTS idx_sh_host_aliases_host ON sh_host_aliases(host_id);

CREATE TABLE IF NOT EXISTS sh_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_key TEXT NOT NULL UNIQUE,
  isrc TEXT,
  spotify_id TEXT,
  stationhead_track_id INTEGER,
  title TEXT,
  artist TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sh_tracks_isrc
  ON sh_tracks(isrc) WHERE isrc IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sh_tracks_spotify
  ON sh_tracks(spotify_id) WHERE spotify_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sh_track_aliases (
  alias_type TEXT NOT NULL,
  alias_value TEXT NOT NULL,
  track_id INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY(alias_type, alias_value),
  FOREIGN KEY(track_id) REFERENCES sh_tracks(id)
);
CREATE INDEX IF NOT EXISTS idx_sh_track_aliases_track ON sh_track_aliases(track_id);

CREATE TABLE IF NOT EXISTS sh_broadcast_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL UNIQUE,
  channel_id INTEGER NOT NULL,
  station_id INTEGER,
  host_id INTEGER,
  broadcast_start_time INTEGER,
  first_observed_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('active','ended')),
  source TEXT NOT NULL,
  FOREIGN KEY(host_id) REFERENCES sh_hosts(id)
);
CREATE INDEX IF NOT EXISTS idx_sh_sessions_channel_time
  ON sh_broadcast_sessions(channel_id, first_observed_at, last_observed_at);
CREATE INDEX IF NOT EXISTS idx_sh_sessions_status
  ON sh_broadcast_sessions(channel_id, status, last_observed_at DESC);

CREATE TABLE IF NOT EXISTS sh_queue_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  channel_id INTEGER NOT NULL,
  station_id INTEGER,
  queue_id INTEGER,
  queue_start_time INTEGER,
  effective_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  structural_hash TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  materialized_item_count INTEGER,
  coverage_complete INTEGER NOT NULL DEFAULT 1,
  source_job_id INTEGER,
  source_visible_count INTEGER,
  last_materialized_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('pending','complete','invalid')),
  source TEXT NOT NULL,
  source_priority INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sh_broadcast_sessions(id),
  UNIQUE(channel_id, effective_at, structural_hash)
);
CREATE INDEX IF NOT EXISTS idx_sh_queue_revisions_channel_effective
  ON sh_queue_revisions(channel_id, effective_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_queue_revisions_session
  ON sh_queue_revisions(session_id, effective_at);
CREATE INDEX IF NOT EXISTS idx_sh_queue_revisions_coverage
  ON sh_queue_revisions(channel_id, coverage_complete, effective_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_queue_revisions_source_job
  ON sh_queue_revisions(source_job_id) WHERE source_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sh_queue_revisions_materialization
  ON sh_queue_revisions(coverage_complete, last_materialized_at, effective_at);

CREATE TABLE IF NOT EXISTS sh_queue_revision_items (
  revision_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  track_id INTEGER,
  queue_track_id INTEGER,
  stationhead_track_id INTEGER,
  isrc TEXT,
  spotify_id TEXT,
  deezer_id TEXT,
  duration_ms INTEGER,
  playback_offset_ms INTEGER,
  schedule_valid INTEGER NOT NULL DEFAULT 0,
  bite_count INTEGER,
  PRIMARY KEY(revision_id, position),
  FOREIGN KEY(revision_id) REFERENCES sh_queue_revisions(id),
  FOREIGN KEY(track_id) REFERENCES sh_tracks(id)
);
CREATE INDEX IF NOT EXISTS idx_sh_queue_revision_items_track
  ON sh_queue_revision_items(track_id, revision_id);

CREATE TABLE IF NOT EXISTS sh_queue_state_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  is_paused INTEGER NOT NULL,
  source TEXT NOT NULL,
  UNIQUE(revision_id, observed_at, is_paused),
  FOREIGN KEY(revision_id) REFERENCES sh_queue_revisions(id)
);
CREATE INDEX IF NOT EXISTS idx_sh_queue_state_events_revision_time
  ON sh_queue_state_events(revision_id, observed_at);

CREATE TABLE IF NOT EXISTS sh_playback_current (
  channel_id INTEGER PRIMARY KEY,
  session_id INTEGER,
  revision_id INTEGER,
  queue_start_time INTEGER,
  is_paused INTEGER NOT NULL DEFAULT 0,
  paused_total_ms INTEGER NOT NULL DEFAULT 0,
  pause_started_at INTEGER,
  last_observed_at INTEGER NOT NULL,
  current_position INTEGER,
  FOREIGN KEY(session_id) REFERENCES sh_broadcast_sessions(id),
  FOREIGN KEY(revision_id) REFERENCES sh_queue_revisions(id)
);

CREATE TABLE IF NOT EXISTS sh_track_bite_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  station_id INTEGER,
  revision_id INTEGER,
  track_id INTEGER NOT NULL,
  queue_position INTEGER,
  bite_count INTEGER NOT NULL,
  source TEXT NOT NULL,
  UNIQUE(channel_id, track_id, observed_at, bite_count),
  FOREIGN KEY(revision_id) REFERENCES sh_queue_revisions(id),
  FOREIGN KEY(track_id) REFERENCES sh_tracks(id)
);
CREATE INDEX IF NOT EXISTS idx_sh_bites_track_time
  ON sh_track_bite_observations(track_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS sh_minute_facts (
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_sh_minute_facts_source_record
  ON sh_minute_facts(source_code, source_record_id)
  WHERE source_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sh_minute_facts_time ON sh_minute_facts(minute_at DESC);
CREATE INDEX IF NOT EXISTS idx_sh_minute_facts_session_time ON sh_minute_facts(broadcast_session_id, minute_at);

CREATE TABLE IF NOT EXISTS sh_migration_state (
  migration_key TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  cursor_observed_at INTEGER NOT NULL DEFAULT 0,
  cursor_source_id INTEGER NOT NULL DEFAULT 0,
  migrated_rows INTEGER NOT NULL DEFAULT 0,
  error_rows INTEGER NOT NULL DEFAULT 0,
  active_session_id INTEGER,
  active_session_key TEXT,
  active_host_id INTEGER,
  active_broadcast_key TEXT,
  active_last_observed_at INTEGER,
  last_error TEXT,
  metadata_json TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sh_system_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL
);
