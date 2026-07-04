-- Persist metadata that can be resolved from another Spotify recording row
-- sharing the same ISRC. This removes the need for display-time supplementation.
WITH ranked AS (
  SELECT
    target.spotify_id AS target_spotify_id,
    source.spotify_id AS source_spotify_id,
    source.title,
    source.artist,
    source.thumbnail_url,
    target_item.isrc,
    ROW_NUMBER() OVER (
      PARTITION BY target.spotify_id
      ORDER BY peer_item.observed_at DESC, source.fetched_at DESC
    ) AS row_rank
  FROM sh_track_metadata AS target
  JOIN sh_queue_items AS target_item
    ON target_item.spotify_id = target.spotify_id
   AND target_item.isrc IS NOT NULL
   AND target_item.isrc <> ''
  JOIN sh_queue_items AS peer_item
    ON peer_item.isrc = target_item.isrc
   AND peer_item.spotify_id IS NOT NULL
   AND peer_item.spotify_id <> ''
   AND peer_item.spotify_id <> target.spotify_id
  JOIN sh_track_metadata AS source
    ON source.spotify_id = peer_item.spotify_id
  WHERE (
      target.title IS NULL OR target.title = ''
      OR target.artist IS NULL OR target.artist = ''
      OR target.title = target.spotify_id
      OR target.artist = target.spotify_id
      OR target.artist GLOB 'JP[A-Z0-9]*'
    )
    AND source.title IS NOT NULL
    AND source.title <> ''
    AND source.artist IS NOT NULL
    AND source.artist <> ''
    AND source.title <> source.spotify_id
    AND source.artist <> source.spotify_id
    AND source.artist NOT GLOB 'JP[A-Z0-9]*'
), resolved AS (
  SELECT * FROM ranked WHERE row_rank = 1
)
UPDATE sh_track_metadata AS target
SET
  title = resolved.title,
  artist = resolved.artist,
  display_title = resolved.title || ' — ' || resolved.artist,
  thumbnail_url = COALESCE(target.thumbnail_url, resolved.thumbnail_url),
  spotify_url = 'https://open.spotify.com/track/' || target.spotify_id,
  source = 'isrc_peer_backfill',
  fetched_at = MAX(target.fetched_at, CAST(strftime('%s','now') AS INTEGER) * 1000)
FROM resolved
WHERE target.spotify_id = resolved.target_spotify_id;

-- Runtime ISRC repair filters by ISRC and chooses the newest peer row.
-- Queue rows are only rewritten when their structure changes, so this index
-- saves substantially more reads than the small write-maintenance cost.
DROP INDEX IF EXISTS idx_sh_sh_queue_items_isrc;
CREATE INDEX IF NOT EXISTS idx_sh_queue_items_isrc_observed_spotify
  ON sh_queue_items(isrc, observed_at DESC, spotify_id);
