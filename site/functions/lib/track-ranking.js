export const TRACK_RANKING_SQL = `WITH resolved AS (
  SELECT
    c.occurrence_key,c.observed_at,c.count_value,c.track_key,
    COALESCE(c.track_id,direct.id,by_isrc.id,by_spotify.id) AS resolved_track_id,
    COALESCE(direct.title,by_isrc.title,by_spotify.title) AS title,
    COALESCE(direct.artist,by_isrc.artist,by_spotify.artist) AS artist,
    COALESCE(c.isrc,direct.isrc,by_isrc.isrc,by_spotify.isrc) AS isrc,
    COALESCE(c.spotify_id,direct.spotify_id,by_isrc.spotify_id,by_spotify.spotify_id) AS spotify_id
  FROM sh_track_counter_current c
  LEFT JOIN sh_tracks direct ON direct.id=c.track_id
  LEFT JOIN sh_tracks by_isrc
    ON c.track_id IS NULL
   AND c.isrc IS NOT NULL AND TRIM(c.isrc)<>''
   AND by_isrc.isrc=UPPER(TRIM(c.isrc))
  LEFT JOIN sh_tracks by_spotify
    ON c.track_id IS NULL AND by_isrc.id IS NULL
   AND c.spotify_id IS NOT NULL AND TRIM(c.spotify_id)<>''
   AND by_spotify.spotify_id=TRIM(c.spotify_id)
  WHERE c.count_value>=0
), eligible AS (
  SELECT *
  FROM resolved
  WHERE TRIM(COALESCE(artist,'')) LIKE '櫻坂%'
     OR UPPER(TRIM(COALESCE(isrc,''))) LIKE 'JP%'
), identified AS (
  SELECT *,
    CASE
      WHEN resolved_track_id IS NOT NULL THEN 'track:'||CAST(resolved_track_id AS TEXT)
      WHEN isrc IS NOT NULL AND TRIM(isrc)<>'' THEN 'isrc:'||UPPER(TRIM(isrc))
      WHEN spotify_id IS NOT NULL AND TRIM(spotify_id)<>'' THEN 'spotify:'||TRIM(spotify_id)
      ELSE 'key:'||track_key
    END AS track_identity
  FROM eligible
), latest_ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY track_identity
      ORDER BY observed_at DESC,occurrence_key DESC
    ) AS identity_rank
  FROM identified
), latest AS (
  SELECT track_identity,
    resolved_track_id AS track_id,title,artist,isrc,spotify_id,
    count_value AS latest_like_count,
    observed_at AS latest_observed_at,
    occurrence_key AS latest_occurrence_key
  FROM latest_ranked
  WHERE identity_rank=1 AND count_value>0
), ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (
      ORDER BY latest_like_count DESC,latest_observed_at DESC,track_identity
    ) AS rank,
    COUNT(*) OVER () AS ranking_track_count,
    MAX(latest_like_count) OVER () AS ranking_max_like_count,
    MAX(latest_observed_at) OVER () AS ranking_latest_observed_at
  FROM latest
)
SELECT rank,track_identity,track_id,title,artist,isrc,spotify_id,
  latest_like_count,latest_observed_at,latest_occurrence_key,
  ranking_track_count,ranking_max_like_count,ranking_latest_observed_at
FROM ranked
ORDER BY rank
LIMIT ?`;

export async function loadTrackRanking(db, { limit = 500 } = {}) {
  const boundedLimit = Math.min(Math.max(Math.trunc(Number(limit) || 500), 20), 500);
  const result = await db.prepare(TRACK_RANKING_SQL).bind(boundedLimit).all();
  const rows = result.results || [];
  const first = rows[0] || {};
  return {
    rows: rows.map(({ ranking_track_count, ranking_max_like_count, ranking_latest_observed_at, ...row }) => row),
    summary: {
      track_count: Number(first.ranking_track_count || 0),
      max_like_count: Number(first.ranking_max_like_count || 0),
      latest_observed_at: Number(first.ranking_latest_observed_at || 0) || null,
    },
  };
}
