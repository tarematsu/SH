-- Canonical ISRC-keyed track presentation dictionary and latest counter view.
-- Metadata is materialized because it is read on the hot playback path. Bite/like
-- values remain derived from the existing canonical counter tables to avoid an
-- extra write for every counter change.

CREATE TABLE IF NOT EXISTS sh_track_dictionary (
  isrc TEXT PRIMARY KEY,
  spotify_id TEXT,
  title TEXT,
  artist TEXT,
  thumbnail_url TEXT,
  metadata_source TEXT NOT NULL DEFAULT 'unknown',
  metadata_fetched_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sh_track_dictionary_spotify
  ON sh_track_dictionary(spotify_id)
  WHERE spotify_id IS NOT NULL AND TRIM(spotify_id)<>'';

INSERT INTO sh_track_dictionary(
  isrc,spotify_id,title,artist,thumbnail_url,
  metadata_source,metadata_fetched_at,updated_at
)
SELECT
  UPPER(REPLACE(REPLACE(TRIM(isrc),'-',''),' ','')),
  NULLIF(TRIM(spotify_id),''),
  NULLIF(TRIM(title),''),
  NULLIF(TRIM(artist),''),
  NULL,
  'track_identity',
  COALESCE(last_seen_at,0),
  COALESCE(last_seen_at,0)
FROM sh_tracks
WHERE isrc IS NOT NULL
  AND LENGTH(UPPER(REPLACE(REPLACE(TRIM(isrc),'-',''),' ','')))=12
ON CONFLICT(isrc) DO UPDATE SET
  spotify_id=COALESCE(sh_track_dictionary.spotify_id,excluded.spotify_id),
  title=COALESCE(sh_track_dictionary.title,excluded.title),
  artist=COALESCE(sh_track_dictionary.artist,excluded.artist),
  updated_at=MAX(sh_track_dictionary.updated_at,excluded.updated_at);

INSERT INTO sh_track_dictionary(
  isrc,spotify_id,title,artist,thumbnail_url,
  metadata_source,metadata_fetched_at,updated_at
)
SELECT
  UPPER(REPLACE(REPLACE(TRIM(isrc),'-',''),' ','')),
  NULL,
  NULLIF(TRIM(title),''),
  NULLIF(TRIM(artist),''),
  NULL,
  source,
  fetched_at,
  fetched_at
FROM sh_isrc_metadata
WHERE isrc IS NOT NULL
  AND LENGTH(UPPER(REPLACE(REPLACE(TRIM(isrc),'-',''),' ','')))=12
ON CONFLICT(isrc) DO UPDATE SET
  title=COALESCE(excluded.title,sh_track_dictionary.title),
  artist=COALESCE(excluded.artist,sh_track_dictionary.artist),
  metadata_source=CASE
    WHEN excluded.metadata_fetched_at>=sh_track_dictionary.metadata_fetched_at
      THEN excluded.metadata_source
    ELSE sh_track_dictionary.metadata_source
  END,
  metadata_fetched_at=MAX(sh_track_dictionary.metadata_fetched_at,excluded.metadata_fetched_at),
  updated_at=MAX(sh_track_dictionary.updated_at,excluded.updated_at);

INSERT INTO sh_track_dictionary(
  isrc,spotify_id,title,artist,thumbnail_url,
  metadata_source,metadata_fetched_at,updated_at
)
SELECT
  UPPER(REPLACE(REPLACE(TRIM(isrc),'-',''),' ','')),
  NULLIF(TRIM(spotify_id),''),
  NULLIF(TRIM(title),''),
  NULLIF(TRIM(artist),''),
  NULLIF(TRIM(thumbnail_url),''),
  source,
  fetched_at,
  fetched_at
FROM sh_track_metadata
WHERE isrc IS NOT NULL
  AND LENGTH(UPPER(REPLACE(REPLACE(TRIM(isrc),'-',''),' ','')))=12
ORDER BY fetched_at
ON CONFLICT(isrc) DO UPDATE SET
  spotify_id=COALESCE(excluded.spotify_id,sh_track_dictionary.spotify_id),
  title=COALESCE(excluded.title,sh_track_dictionary.title),
  artist=COALESCE(excluded.artist,sh_track_dictionary.artist),
  thumbnail_url=COALESCE(excluded.thumbnail_url,sh_track_dictionary.thumbnail_url),
  metadata_source=CASE
    WHEN excluded.metadata_fetched_at>=sh_track_dictionary.metadata_fetched_at
      THEN excluded.metadata_source
    ELSE sh_track_dictionary.metadata_source
  END,
  metadata_fetched_at=MAX(sh_track_dictionary.metadata_fetched_at,excluded.metadata_fetched_at),
  updated_at=MAX(sh_track_dictionary.updated_at,excluded.updated_at);

CREATE TRIGGER IF NOT EXISTS trg_sh_track_dictionary_metadata_insert
AFTER INSERT ON sh_track_metadata
WHEN NEW.isrc IS NOT NULL
  AND LENGTH(UPPER(REPLACE(REPLACE(TRIM(NEW.isrc),'-',''),' ','')))=12
BEGIN
  INSERT INTO sh_track_dictionary(
    isrc,spotify_id,title,artist,thumbnail_url,
    metadata_source,metadata_fetched_at,updated_at
  ) VALUES(
    UPPER(REPLACE(REPLACE(TRIM(NEW.isrc),'-',''),' ','')),
    NULLIF(TRIM(NEW.spotify_id),''),
    NULLIF(TRIM(NEW.title),''),
    NULLIF(TRIM(NEW.artist),''),
    NULLIF(TRIM(NEW.thumbnail_url),''),
    NEW.source,
    NEW.fetched_at,
    NEW.fetched_at
  )
  ON CONFLICT(isrc) DO UPDATE SET
    spotify_id=COALESCE(excluded.spotify_id,sh_track_dictionary.spotify_id),
    title=COALESCE(excluded.title,sh_track_dictionary.title),
    artist=COALESCE(excluded.artist,sh_track_dictionary.artist),
    thumbnail_url=COALESCE(excluded.thumbnail_url,sh_track_dictionary.thumbnail_url),
    metadata_source=CASE
      WHEN excluded.metadata_fetched_at>=sh_track_dictionary.metadata_fetched_at
        THEN excluded.metadata_source
      ELSE sh_track_dictionary.metadata_source
    END,
    metadata_fetched_at=MAX(sh_track_dictionary.metadata_fetched_at,excluded.metadata_fetched_at),
    updated_at=MAX(sh_track_dictionary.updated_at,excluded.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_sh_track_dictionary_metadata_update
AFTER UPDATE OF isrc,spotify_id,title,artist,thumbnail_url,source,fetched_at ON sh_track_metadata
WHEN NEW.isrc IS NOT NULL
  AND LENGTH(UPPER(REPLACE(REPLACE(TRIM(NEW.isrc),'-',''),' ','')))=12
BEGIN
  INSERT INTO sh_track_dictionary(
    isrc,spotify_id,title,artist,thumbnail_url,
    metadata_source,metadata_fetched_at,updated_at
  ) VALUES(
    UPPER(REPLACE(REPLACE(TRIM(NEW.isrc),'-',''),' ','')),
    NULLIF(TRIM(NEW.spotify_id),''),
    NULLIF(TRIM(NEW.title),''),
    NULLIF(TRIM(NEW.artist),''),
    NULLIF(TRIM(NEW.thumbnail_url),''),
    NEW.source,
    NEW.fetched_at,
    NEW.fetched_at
  )
  ON CONFLICT(isrc) DO UPDATE SET
    spotify_id=COALESCE(excluded.spotify_id,sh_track_dictionary.spotify_id),
    title=COALESCE(excluded.title,sh_track_dictionary.title),
    artist=COALESCE(excluded.artist,sh_track_dictionary.artist),
    thumbnail_url=COALESCE(excluded.thumbnail_url,sh_track_dictionary.thumbnail_url),
    metadata_source=CASE
      WHEN excluded.metadata_fetched_at>=sh_track_dictionary.metadata_fetched_at
        THEN excluded.metadata_source
      ELSE sh_track_dictionary.metadata_source
    END,
    metadata_fetched_at=MAX(sh_track_dictionary.metadata_fetched_at,excluded.metadata_fetched_at),
    updated_at=MAX(sh_track_dictionary.updated_at,excluded.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_sh_track_dictionary_isrc_metadata_insert
AFTER INSERT ON sh_isrc_metadata
WHEN NEW.isrc IS NOT NULL
  AND LENGTH(UPPER(REPLACE(REPLACE(TRIM(NEW.isrc),'-',''),' ','')))=12
BEGIN
  INSERT INTO sh_track_dictionary(
    isrc,spotify_id,title,artist,thumbnail_url,
    metadata_source,metadata_fetched_at,updated_at
  ) VALUES(
    UPPER(REPLACE(REPLACE(TRIM(NEW.isrc),'-',''),' ','')),
    NULL,
    NULLIF(TRIM(NEW.title),''),
    NULLIF(TRIM(NEW.artist),''),
    NULL,
    NEW.source,
    NEW.fetched_at,
    NEW.fetched_at
  )
  ON CONFLICT(isrc) DO UPDATE SET
    title=COALESCE(sh_track_dictionary.title,excluded.title),
    artist=COALESCE(sh_track_dictionary.artist,excluded.artist),
    metadata_source=CASE
      WHEN sh_track_dictionary.metadata_source='unknown'
        THEN excluded.metadata_source
      ELSE sh_track_dictionary.metadata_source
    END,
    metadata_fetched_at=MAX(sh_track_dictionary.metadata_fetched_at,excluded.metadata_fetched_at),
    updated_at=MAX(sh_track_dictionary.updated_at,excluded.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_sh_track_dictionary_isrc_metadata_update
AFTER UPDATE OF title,artist,source,fetched_at ON sh_isrc_metadata
WHEN NEW.isrc IS NOT NULL
  AND LENGTH(UPPER(REPLACE(REPLACE(TRIM(NEW.isrc),'-',''),' ','')))=12
BEGIN
  INSERT INTO sh_track_dictionary(
    isrc,spotify_id,title,artist,thumbnail_url,
    metadata_source,metadata_fetched_at,updated_at
  ) VALUES(
    UPPER(REPLACE(REPLACE(TRIM(NEW.isrc),'-',''),' ','')),
    NULL,
    NULLIF(TRIM(NEW.title),''),
    NULLIF(TRIM(NEW.artist),''),
    NULL,
    NEW.source,
    NEW.fetched_at,
    NEW.fetched_at
  )
  ON CONFLICT(isrc) DO UPDATE SET
    title=COALESCE(sh_track_dictionary.title,excluded.title),
    artist=COALESCE(sh_track_dictionary.artist,excluded.artist),
    metadata_source=CASE
      WHEN sh_track_dictionary.metadata_source='unknown'
        THEN excluded.metadata_source
      ELSE sh_track_dictionary.metadata_source
    END,
    metadata_fetched_at=MAX(sh_track_dictionary.metadata_fetched_at,excluded.metadata_fetched_at),
    updated_at=MAX(sh_track_dictionary.updated_at,excluded.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_sh_track_dictionary_track_insert
AFTER INSERT ON sh_tracks
WHEN NEW.isrc IS NOT NULL
  AND LENGTH(UPPER(REPLACE(REPLACE(TRIM(NEW.isrc),'-',''),' ','')))=12
BEGIN
  INSERT INTO sh_track_dictionary(
    isrc,spotify_id,title,artist,thumbnail_url,
    metadata_source,metadata_fetched_at,updated_at
  ) VALUES(
    UPPER(REPLACE(REPLACE(TRIM(NEW.isrc),'-',''),' ','')),
    NULLIF(TRIM(NEW.spotify_id),''),
    NULLIF(TRIM(NEW.title),''),
    NULLIF(TRIM(NEW.artist),''),
    NULL,
    'track_identity',
    COALESCE(NEW.last_seen_at,0),
    COALESCE(NEW.last_seen_at,0)
  )
  ON CONFLICT(isrc) DO UPDATE SET
    spotify_id=COALESCE(sh_track_dictionary.spotify_id,excluded.spotify_id),
    title=COALESCE(sh_track_dictionary.title,excluded.title),
    artist=COALESCE(sh_track_dictionary.artist,excluded.artist),
    updated_at=MAX(sh_track_dictionary.updated_at,excluded.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_sh_track_dictionary_track_isrc_update
AFTER UPDATE OF isrc ON sh_tracks
WHEN NEW.isrc IS NOT NULL
  AND (OLD.isrc IS NULL OR OLD.isrc IS NOT NEW.isrc)
  AND LENGTH(UPPER(REPLACE(REPLACE(TRIM(NEW.isrc),'-',''),' ','')))=12
BEGIN
  INSERT INTO sh_track_dictionary(
    isrc,spotify_id,title,artist,thumbnail_url,
    metadata_source,metadata_fetched_at,updated_at
  ) VALUES(
    UPPER(REPLACE(REPLACE(TRIM(NEW.isrc),'-',''),' ','')),
    NULLIF(TRIM(NEW.spotify_id),''),
    NULLIF(TRIM(NEW.title),''),
    NULLIF(TRIM(NEW.artist),''),
    NULL,
    'track_identity',
    COALESCE(NEW.last_seen_at,0),
    COALESCE(NEW.last_seen_at,0)
  )
  ON CONFLICT(isrc) DO UPDATE SET
    spotify_id=COALESCE(sh_track_dictionary.spotify_id,excluded.spotify_id),
    title=COALESCE(sh_track_dictionary.title,excluded.title),
    artist=COALESCE(sh_track_dictionary.artist,excluded.artist),
    updated_at=MAX(sh_track_dictionary.updated_at,excluded.updated_at);
END;

CREATE INDEX IF NOT EXISTS idx_sh_track_counter_current_isrc_observed
  ON sh_track_counter_current(isrc,observed_at DESC)
  WHERE isrc IS NOT NULL AND TRIM(isrc)<>'';

DROP VIEW IF EXISTS sh_track_stats_by_isrc;
CREATE VIEW sh_track_stats_by_isrc AS
WITH normalized AS (
  SELECT
    COALESCE(
      NULLIF(UPPER(REPLACE(REPLACE(TRIM(current.isrc),'-',''),' ','')),''),
      NULLIF(UPPER(REPLACE(REPLACE(TRIM(track.isrc),'-',''),' ','')),'')
    ) AS isrc,
    current.count_value AS latest_bite_count,
    current.observed_at AS latest_observed_at,
    current.station_id,
    current.occurrence_key,
    current.track_key,
    current.change_id
  FROM sh_track_counter_current AS current
  LEFT JOIN sh_tracks AS track ON track.id=current.track_id
), ranked AS (
  SELECT normalized.*,
    ROW_NUMBER() OVER(
      PARTITION BY isrc
      ORDER BY latest_observed_at DESC,change_id DESC
    ) AS row_rank
  FROM normalized
  WHERE LENGTH(isrc)=12
)
SELECT
  isrc,
  latest_bite_count,
  latest_observed_at,
  station_id,
  occurrence_key,
  track_key
FROM ranked
WHERE row_rank=1;
