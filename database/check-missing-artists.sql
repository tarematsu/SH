SELECT
  COUNT(*) AS queue_items_without_artist
FROM sh_queue_items q
LEFT JOIN sh_track_metadata m ON m.spotify_id = q.spotify_id
WHERE q.observed_at >= (unixepoch('now', '-30 days') * 1000)
  AND COALESCE(TRIM(m.artist), '') = '';

SELECT DISTINCT
  q.spotify_id,
  q.apple_music_id,
  q.isrc,
  m.title,
  m.artist,
  m.source,
  datetime(q.observed_at / 1000, 'unixepoch', '+9 hours') AS observed_jst
FROM sh_queue_items q
LEFT JOIN sh_track_metadata m ON m.spotify_id = q.spotify_id
WHERE q.observed_at >= (unixepoch('now', '-30 days') * 1000)
  AND COALESCE(TRIM(m.artist), '') = ''
ORDER BY q.observed_at DESC
LIMIT 50;
