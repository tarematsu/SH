const DAY_MS = 86_400_000;
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=1800',
  vary: 'accept-encoding',
};

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: status >= 400 ? { ...JSON_HEADERS, 'cache-control': 'no-store' } : JSON_HEADERS,
});

const VALID_SORTS = new Set(['total', 'peak', 'average']);

function validDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const timestamp = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === text;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoUtc(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

const BASE_CTES = `WITH resolved AS (
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
  WHERE c.observed_at>=? AND c.observed_at<? AND c.count_value>0
), identified AS (
  SELECT *,
    CASE
      WHEN resolved_track_id IS NOT NULL THEN 'track:'||CAST(resolved_track_id AS TEXT)
      WHEN isrc IS NOT NULL AND TRIM(isrc)<>'' THEN 'isrc:'||UPPER(TRIM(isrc))
      WHEN spotify_id IS NOT NULL AND TRIM(spotify_id)<>'' THEN 'spotify:'||TRIM(spotify_id)
      ELSE 'key:'||track_key
    END AS track_identity
  FROM resolved
), grouped AS (
  SELECT track_identity,
    MAX(resolved_track_id) AS track_id,
    MAX(title) AS title,
    MAX(artist) AS artist,
    MAX(isrc) AS isrc,
    MAX(spotify_id) AS spotify_id,
    SUM(count_value) AS total_like_count,
    MAX(count_value) AS peak_like_count,
    AVG(count_value) AS average_like_count,
    COUNT(*) AS occurrence_count,
    MIN(observed_at) AS first_observed_at,
    MAX(observed_at) AS latest_observed_at
  FROM identified
  GROUP BY track_identity
), ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (ORDER BY __ORDER__) AS rank,
    SUM(total_like_count) OVER () AS period_like_count,
    SUM(occurrence_count) OVER () AS period_occurrence_count,
    COUNT(*) OVER () AS period_track_count,
    MAX(peak_like_count) OVER () AS period_peak_like_count
  FROM grouped
)
SELECT rank,track_identity,track_id,title,artist,isrc,spotify_id,
  total_like_count,peak_like_count,average_like_count,occurrence_count,
  first_observed_at,latest_observed_at,
  period_like_count,period_occurrence_count,period_track_count,period_peak_like_count
FROM ranked
ORDER BY rank
LIMIT ?`;

const ORDER_BY = Object.freeze({
  total: 'total_like_count DESC,peak_like_count DESC,latest_observed_at DESC,track_identity',
  peak: 'peak_like_count DESC,total_like_count DESC,latest_observed_at DESC,track_identity',
  average: 'average_like_count DESC,total_like_count DESC,latest_observed_at DESC,track_identity',
});

export function likeRankingSql(sort = 'total') {
  return BASE_CTES.replaceAll('__ORDER__', ORDER_BY[VALID_SORTS.has(sort) ? sort : 'total']);
}

export async function loadLikeRanking(db, { fromTs, toTs, limit, sort }) {
  const result = await db.prepare(likeRankingSql(sort)).bind(fromTs, toTs, limit).all();
  const rows = result.results || [];
  const first = rows[0] || {};
  return {
    rows: rows.map(({ period_like_count, period_occurrence_count, period_track_count, period_peak_like_count, ...row }) => row),
    summary: {
      total_like_count: Number(first.period_like_count || 0),
      occurrence_count: Number(first.period_occurrence_count || 0),
      track_count: Number(first.period_track_count || 0),
      peak_like_count: Number(first.period_peak_like_count || 0),
    },
  };
}

export async function onRequestGet({ request, env }) {
  if (!env.MINUTE_DB) return json({ ok: false, error: 'MINUTE_DB binding missing' }, 500);
  const url = new URL(request.url);
  const from = url.searchParams.get('from') || daysAgoUtc(30);
  const to = url.searchParams.get('to') || todayUtc();
  if (!validDate(from) || !validDate(to)) {
    return json({ ok: false, error: 'from and to must be valid YYYY-MM-DD dates' }, 400);
  }
  const fromTs = Date.parse(`${from}T00:00:00Z`);
  const toTs = Date.parse(`${to}T00:00:00Z`) + DAY_MS;
  if (fromTs >= toTs) return json({ ok: false, error: 'from must not be after to' }, 400);

  const requestedLimit = Number(url.searchParams.get('limit'));
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 200, 20), 500);
  const requestedSort = String(url.searchParams.get('sort') || 'total');
  const sort = VALID_SORTS.has(requestedSort) ? requestedSort : 'total';

  try {
    const ranking = await loadLikeRanking(env.MINUTE_DB, { fromTs, toTs, limit, sort });
    return json({
      ok: true,
      mode: 'likes',
      from,
      to,
      sort,
      limit,
      counter_name: 'like/bite',
      source: 'stationhead-minute.sh_track_counter_current',
      ...ranking,
    });
  } catch (error) {
    if (/no such table|no such column/i.test(String(error?.message || ''))) {
      return json({ ok: true, mode: 'likes', from, to, sort, rows: [], summary: {}, setup_required: true });
    }
    return json({ ok: false, error: error?.message || 'like ranking error' }, 500);
  }
}
