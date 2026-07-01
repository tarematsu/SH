const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=7200',
};
const MAX_POINTS = 120000;
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: status === 200 ? JSON_HEADERS : { ...JSON_HEADERS, 'cache-control': 'no-store' },
});
function parseDateStart(value, fallback) {
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : fallback;
  return Date.parse(`${text}T00:00:00Z`);
}
function addDays(timestamp, days) { return timestamp + days * 86400000; }
function todayUtcString() { return new Date().toISOString().slice(0, 10); }
export const LEGACY_SERIES_SQL = `WITH starts AS (
  SELECT source_note AS event_name, MIN(observed_at) AS started_at
  FROM sh_legacy_snapshots
  WHERE observed_at>=? AND observed_at<?
    AND host_handle='sakurazaka46jp'
    AND source_note IS NOT NULL AND source_note<>''
  GROUP BY source_note
), minute_points AS (
  SELECT
    'legacy:' || snapshots.source_note AS series_key,
    snapshots.source_note AS event_name,
    starts.started_at,
    CAST((snapshots.observed_at - starts.started_at) / 60000 AS INTEGER) AS elapsed_minute,
    ROUND(AVG(snapshots.listener_count), 1) AS listener_count,
    COUNT(*) AS source_samples
  FROM sh_legacy_snapshots snapshots
  JOIN starts ON starts.event_name=snapshots.source_note
  WHERE snapshots.observed_at>=? AND snapshots.observed_at<?
    AND snapshots.host_handle='sakurazaka46jp'
    AND snapshots.listener_count IS NOT NULL
  GROUP BY snapshots.source_note,starts.started_at,elapsed_minute
), ranked AS (
  SELECT *,ROW_NUMBER() OVER (ORDER BY started_at ASC,elapsed_minute ASC) AS point_rank,
    COUNT(*) OVER () AS total_points
  FROM minute_points
), ordered AS (
  SELECT series_key,event_name,started_at,elapsed_minute,listener_count,source_samples,total_points
  FROM ranked WHERE point_rank<=${MAX_POINTS}
  ORDER BY started_at ASC,elapsed_minute ASC
)
SELECT series_key,event_name,started_at,
  json_group_array(json_array(elapsed_minute,listener_count,source_samples)) AS points_json,
  COUNT(*) AS point_count,MAX(total_points) AS total_points
FROM ordered
GROUP BY series_key,event_name,started_at
ORDER BY started_at ASC`;
export const FAILSAFE_SERIES_SQL = `WITH minute_points AS (
  SELECT
    'news:' || announcements.id AS series_key,
    announcements.event_name AS event_name,
    COALESCE(announcements.first_broadcast_at,announcements.scheduled_at) AS started_at,
    CAST((probes.observed_at - COALESCE(announcements.first_broadcast_at,announcements.scheduled_at)) / 60000 AS INTEGER) AS elapsed_minute,
    ROUND(AVG(probes.listener_count), 1) AS listener_count,
    COUNT(*) AS source_samples
  FROM sh_official_news_announcements announcements
  JOIN sh_official_news_station_probes probes ON probes.announcement_id=announcements.id
  WHERE COALESCE(announcements.first_broadcast_at,announcements.scheduled_at)>=?
    AND COALESCE(announcements.first_broadcast_at,announcements.scheduled_at)<?
    AND probes.is_broadcasting=1
    AND probes.listener_count IS NOT NULL
  GROUP BY announcements.id,announcements.event_name,started_at,elapsed_minute
), ranked AS (
  SELECT *,ROW_NUMBER() OVER (ORDER BY started_at ASC,elapsed_minute ASC) AS point_rank,
    COUNT(*) OVER () AS total_points
  FROM minute_points
), ordered AS (
  SELECT series_key,event_name,started_at,elapsed_minute,listener_count,source_samples,total_points
  FROM ranked WHERE point_rank<=${MAX_POINTS}
  ORDER BY started_at ASC,elapsed_minute ASC
)
SELECT series_key,event_name,started_at,
  json_group_array(json_array(elapsed_minute,listener_count,source_samples)) AS points_json,
  COUNT(*) AS point_count,MAX(total_points) AS total_points
FROM ordered
GROUP BY series_key,event_name,started_at
ORDER BY started_at ASC`;
export function decodeSeriesRows(rows, source) {
  return (rows || []).map((row) => {
    let encoded = [];
    try {
      const parsed = JSON.parse(row.points_json || '[]');
      if (Array.isArray(parsed)) encoded = parsed;
    } catch {}
    const samples = encoded.map((point) => ({
      elapsed: Number(point?.[0]) || 0,
      listener: Number(point?.[1]),
      sourceSamples: Number(point?.[2]) || 0,
    })).filter((point) => Number.isFinite(point.listener));
    return {
      series_key: String(row.series_key || `${row.event_name}:${row.started_at}`),
      event_name: String(row.event_name || '公式ステヘ'),
      started_at: Number(row.started_at) || null,
      samples,
      source,
      sourceTruncated: Number(row.total_points || 0) > MAX_POINTS,
    };
  });
}
export function trimSeries(seriesRows, limit = MAX_POINTS) {
  const ordered = [...seriesRows].sort((a, b) => (a.started_at || 0) - (b.started_at || 0));
  const result = [];
  let remaining = limit;
  let originalPoints = 0;
  let sourceTruncated = false;
  for (const row of ordered) {
    originalPoints += row.samples.length;
    sourceTruncated ||= Boolean(row.sourceTruncated);
    if (remaining <= 0) continue;
    const samples = row.samples.slice(0, remaining);
    remaining -= samples.length;
    if (!samples.length) continue;
    result.push({
      event_name: row.event_name,
      started_at: row.started_at,
      points: samples.map((point) => [point.elapsed, point.listener]),
      source_samples: samples.reduce((sum, point) => sum + point.sourceSamples, 0),
      source: row.source,
    });
  }
  return { series: result, pointCount: limit - remaining, truncated: sourceTruncated || originalPoints > limit };
}
async function legacyRows(env, fromTs, toTs) {
  const result = await env.DB.prepare(LEGACY_SERIES_SQL).bind(fromTs, toTs, fromTs, toTs).all();
  return decodeSeriesRows(result.results || [], 'historical_import');
}
async function failSafeRows(env, fromTs, toTs) {
  try {
    const result = await env.DB.prepare(FAILSAFE_SERIES_SQL).bind(fromTs, toTs).all();
    return decodeSeriesRows(result.results || [], 'official_news_fail_safe');
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) return [];
    throw error;
  }
}
export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);
  try {
    const url = new URL(request.url);
    const from = url.searchParams.get('from') || '2024-05-01';
    const to = url.searchParams.get('to') || todayUtcString();
    const fromTs = parseDateStart(from, '2024-05-01');
    const toTs = addDays(parseDateStart(to, todayUtcString()), 1);
    const [legacy, failSafe] = await Promise.all([legacyRows(env, fromTs, toTs), failSafeRows(env, fromTs, toTs)]);
    const trimmed = trimSeries([...legacy, ...failSafe]);
    return json({
      ok: true, from, to, timezone: 'UTC', series: trimmed.series,
      event_count: trimmed.series.length, point_count: trimmed.pointCount,
      fail_safe_event_count: trimmed.series.filter((item) => item.source === 'official_news_fail_safe').length,
      truncated: trimmed.truncated, x_origin: 'broadcast_start', x_unit: 'minute',
    });
  } catch (error) {
    return json({ ok: false, error: error?.message || 'broadcast series error' }, 500);
  }
}
