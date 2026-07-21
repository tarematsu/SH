CREATE TABLE IF NOT EXISTS sh_pages_payload_read_model (
  model_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sh_pages_response_manifest (
  model_key TEXT PRIMARY KEY,
  generation TEXT NOT NULL,
  status INTEGER NOT NULL,
  headers_json TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sh_pages_response_chunks (
  model_key TEXT NOT NULL,
  generation TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  payload_chunk TEXT NOT NULL,
  PRIMARY KEY(model_key,generation,chunk_index)
);

DELETE FROM sh_pages_payload_read_model
WHERE model_key IN (
  'dashboard-daily-changes',
  'dashboard-history',
  'dashboard-queue',
  'dashboard-recovery',
  'comment-velocity',
  'track-likes',
  'like-ranking',
  'minute-facts-current',
  'minute-facts-latest',
  'playback',
  'playback:buddies',
  'playback:buddy46',
  'broadcast-series',
  'history-raw',
  'official-history'
);

DELETE FROM sh_pages_response_chunks
WHERE model_key IN (
  'dashboard-daily-changes',
  'dashboard-history',
  'dashboard-queue',
  'dashboard-recovery',
  'comment-velocity',
  'track-likes',
  'like-ranking',
  'minute-facts-current',
  'minute-facts-latest',
  'playback',
  'playback:buddies',
  'playback:buddy46',
  'broadcast-series',
  'history-raw',
  'official-history'
);

DELETE FROM sh_pages_response_manifest
WHERE model_key IN (
  'dashboard-daily-changes',
  'dashboard-history',
  'dashboard-queue',
  'dashboard-recovery',
  'comment-velocity',
  'track-likes',
  'like-ranking',
  'minute-facts-current',
  'minute-facts-latest',
  'playback',
  'playback:buddies',
  'playback:buddy46',
  'broadcast-series',
  'history-raw',
  'official-history'
);
