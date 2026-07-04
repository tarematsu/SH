WITH candidates AS (
  SELECT spotify_id, isrc
  FROM sh_queue_items
  WHERE spotify_id IS NOT NULL AND spotify_id <> ''
    AND isrc IS NOT NULL AND isrc <> ''
  GROUP BY spotify_id, isrc
), ranked AS (
  SELECT
    candidates.spotify_id AS target_spotify_id,
    candidates.isrc,
    source.spotify_id AS source_spotify_id,
    source.title,
    source.artist,
    source.thumbnail_url,
    ROW_NUMBER() OVER (
      PARTITION BY candidates.spotify_id
      ORDER BY peer_item.observed_at DESC, source.fetched_at DESC
    ) AS row_rank
  FROM candidates
  JOIN sh_queue_items AS peer_item
    ON peer_item.isrc = candidates.isrc
   AND peer_item.spotify_id IS NOT NULL
   AND peer_item.spotify_id <> ''
   AND peer_item.spotify_id <> candidates.spotify_id
  JOIN sh_track_metadata AS source
    ON source.spotify_id = peer_item.spotify_id
  WHERE source.title IS NOT NULL AND source.title <> ''
    AND source.artist IS NOT NULL AND source.artist <> ''
    AND source.title <> source.spotify_id
    AND source.artist <> source.spotify_id
    AND source.artist NOT GLOB 'JP[A-Z0-9]*'
), resolved AS (
  SELECT * FROM ranked WHERE row_rank = 1
)
INSERT INTO sh_track_metadata (
  spotify_id,title,artist,display_title,thumbnail_url,
  spotify_url,source,fetched_at,raw_json
)
SELECT
  target_spotify_id,
  title,
  artist,
  title || ' — ' || artist,
  thumbnail_url,
  'https://open.spotify.com/track/' || target_spotify_id,
  'isrc_peer_backfill',
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  NULL
FROM resolved
WHERE row_rank = 1
ON CONFLICT(spotify_id) DO UPDATE SET
  title = excluded.title,
  artist = excluded.artist,
  display_title = excluded.display_title,
  thumbnail_url = COALESCE(sh_track_metadata.thumbnail_url, excluded.thumbnail_url),
  spotify_url = excluded.spotify_url,
  source = excluded.source,
  fetched_at = MAX(sh_track_metadata.fetched_at, excluded.fetched_at)
WHERE sh_track_metadata.title IS NULL
   OR sh_track_metadata.title = ''
   OR sh_track_metadata.artist IS NULL
   OR sh_track_metadata.artist = ''
   OR sh_track_metadata.title = sh_track_metadata.spotify_id
   OR sh_track_metadata.artist = sh_track_metadata.spotify_id
   OR sh_track_metadata.artist GLOB 'JP[A-Z0-9]*';

DROP INDEX IF EXISTS idx_sh_sh_queue_items_isrc;
CREATE INDEX IF NOT EXISTS idx_sh_queue_items_isrc_observed_spotify
  ON sh_queue_items(isrc, observed_at DESC, spotify_id);
