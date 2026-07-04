-- Compact high-frequency D1 writes into current-state rows and sparse history.
CREATE TABLE IF NOT EXISTS sh_snapshot_current (
  channel_key TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  last_snapshot_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sh_queue_current (
  station_id INTEGER PRIMARY KEY,
  queue_id INTEGER,
  start_time INTEGER,
  structural_hash TEXT NOT NULL,
  is_paused INTEGER,
  observed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sh_track_like_current (
  station_id INTEGER NOT NULL,
  track_key TEXT NOT NULL,
  queue_id INTEGER,
  start_time INTEGER,
  position INTEGER,
  queue_track_id INTEGER,
  stationhead_track_id INTEGER,
  spotify_id TEXT,
  apple_music_id TEXT,
  isrc TEXT,
  like_count INTEGER,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY(station_id,track_key)
);

CREATE INDEX IF NOT EXISTS idx_sh_track_like_current_observed
  ON sh_track_like_current(station_id,observed_at DESC);

INSERT INTO sh_track_like_current(
  station_id,track_key,queue_id,start_time,position,queue_track_id,
  stationhead_track_id,spotify_id,apple_music_id,isrc,like_count,observed_at
)
SELECT station_id,track_key,queue_id,start_time,position,queue_track_id,
       stationhead_track_id,spotify_id,apple_music_id,isrc,like_count,observed_at
FROM (
  SELECT observations.*,
         ROW_NUMBER() OVER (
           PARTITION BY station_id,track_key
           ORDER BY observed_at DESC,id DESC
         ) AS row_rank
  FROM sh_track_like_observations observations
)
WHERE row_rank=1
ON CONFLICT(station_id,track_key) DO UPDATE SET
  queue_id=excluded.queue_id,
  start_time=excluded.start_time,
  position=excluded.position,
  queue_track_id=excluded.queue_track_id,
  stationhead_track_id=excluded.stationhead_track_id,
  spotify_id=excluded.spotify_id,
  apple_music_id=excluded.apple_music_id,
  isrc=excluded.isrc,
  like_count=excluded.like_count,
  observed_at=excluded.observed_at
WHERE excluded.observed_at>=sh_track_like_current.observed_at;
