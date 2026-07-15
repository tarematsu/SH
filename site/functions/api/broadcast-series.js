import { isRealIsoDate } from '../lib/api-utils.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=7200',
  vary: 'accept-encoding',
};
const MAX_POINTS = 120000;
const SERIES_CACHE_TTL_MS = 5 * 60 * 1000;
const SERIES_CACHE_MAX = 8;
const seriesCache = new Map();

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: status === 200 ? JSON_HEADERS : { ...JSON_HEADERS, 'cache-control': 'no-store' },
});

function dateParam(value, fallback) {
  return isRealIsoDate(value) ? value : fallback;
}
function parseDateStart(value) { return Date.parse(`${value}T00:00:00Z`); }
function addDays(timestamp, days) { return timestamp + days * 86400000; }
function todayUtcString() { return new Date().toISOString().slice(0, 10); }

export async function cachedBroadcastSeries(key, loader, now = Date.now()) {
  const cached = seriesCache.get(key);
  if (cached?.expiresAt > now && Object.hasOwn(cached, 'value')) {
    seriesCache.delete(key);
    seriesCache.set(key, cached);
    return cached.value;
  }
  if (cached?.pending) return cached.pending;

  const entry = cached || {};
  entry.pending = Promise.resolve().then(loader).then((value) => {
    entry.value = value;
    entry.expiresAt = Date.now() + SERIES_CACHE_TTL_MS;
    return value;
  }).catch((error) => {
    seriesCache.delete(key);
    throw error;
  }).finally(() => { entry.pending = null; });
  seriesCache.set(key, entry);
  while (seriesCache.size > SERIES_CACHE_MAX) {
    seriesCache.delete(seriesCache.keys().next().value);
  }
  return entry.pending;
}

export function resetBroadcastSeriesCache() {
  seriesCache.clear();
}

export const LEGACY_SERIES_SQL = `SELECT event_name,started_at,ended_at
FROM sh_official_broadcast_summary
WHERE host_handle='sakurazaka46jp' AND started_at>=? AND started_at<?
ORDER BY started_at ASC`;

export const MINUTE_SERIES_SQL = `WITH minute_points AS (
  SELECT CAST((f.minute_at-?)/60000 AS INTEGER) AS elapsed_minute,
    ROUND(AVG(f.listener_count),1) AS listener_count,COUNT(*) AS source_samples
  FROM sh_minute_facts f
  LEFT JOIN sh_minute_fact_context c ON c.fact_id=f.id
  LEFT JOIN sh_hosts h ON h.id=c.host_id
  WHERE f.source_code IN (3,4)
    AND f.minute_at>=? AND f.minute_at<?
    AND lower(COALESCE(h.current_handle,''))='sakurazaka46jp'
    AND f.listener_count IS NOT NULL
  GROUP BY elapsed_minute
), ranked AS (
  SELECT *,ROW_NUMBER() OVER (ORDER BY elapsed_minute ASC) AS point_rank,
    COUNT(*) OVER () AS total_points
  FROM minute_points
), ordered AS (
  SELECT elapsed_minute,listener_count,source_samples,total_points
  FROM ranked WHERE point_rank<=${MAX_POINTS}
  ORDER BY elapsed_minute ASC
)
SELECT json_group_array(json_array(elapsed_minute,listener_count,source_samples)) AS points_json,
  COUNT(*) AS point_count,COALESCE(MAX(total_points),0) AS total_points
FROM ordered`;

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
  const result = [];
  for (const row of rows || []) {
    let encoded = [];
    try {
      const parsed = JSON.parse(row.points_json || '[]');
      if (Array.isArray(parsed)) encoded = parsed;
    } catch {}
    const samples = [];
    for (const point of encoded) {
      const listener = Number(point?.[1]);
      if (!Number.isFinite(listener)) continue;
      samples.push({
        elapsed: Number(point?.[0]) || 0,
        listener,
        sourceSamples: Number(point?.[2]) || 0,
      });
    }
    result.push({
      series_key: String(row.series_key || `${row.event_name}:${row.started_at}`),
      event_name: String(row.event_name || '公式ステヘ'),
      started_at: Number(row.started_at) || null,
      samples,
      source,
      sourceTruncated: Number(row.total_points || 0) > MAX_POINTS,
    });
  }
  return result;
}

export function trimSeries(seriesRows, limit = MAX_POINTS) {
  const ordered = [...seriesRows].sort((a, b) => (a.started_at || 0) - (b.started_at || 0));
  const result = [];
  let remaining = limit;
  let originalPoints = 0;
  let sourceTruncated = false;
  for (const row of ordered) {
    const samples = Array.isArray(row.samples) ? row.samples : [];
    originalPoints += samples.length;
    sourceTruncated ||= Boolean(row.sourceTruncated);
    if (remaining <= 0 || !samples.length) continue;
    const take = Math.min(samples.length, remaining);
    const points = new Array(take);
    let sourceSamples = 0;
    for (let index = 0; index < take; index += 1) {
      const point = samples[index];
      points[index] = [point.elapsed, point.listener];
      sourceSamples += point.sourceSamples;
    }
    remaining -= take;
    result.push({
      event_name: row.event_name,
      started_at: row.started_at,
      points,
      source_samples: sourceSamples,
      source: row.source,
    });
  }
  return { series: result, pointCount: limit - remaining, truncated: sourceTruncated || originalPoints > limit };
}

// Official event boundaries remain in OTHER_DB; historical points are rebuilt
// from the compact legacy facts in MINUTE_DB. The raw legacy table is not read.
export async function loadBroadcastSeriesRows(minuteDb, otherDb, fromTs, toTs) {
  let legacyRows = [];
  const summaryResult = await otherDb.prepare(LEGACY_SERIES_SQL).bind(fromTs, toTs).all();
  const summaries = summaryResult.results || [];
  for (const summary of summaries) {
    const start = Number(summary.started_at || 0);
    const end = Number(summary.ended_at || start) + 60_000;
    const pointsResult = await minuteDb.prepare(MINUTE_SERIES_SQL)
      .bind(start, start, end).all();
    const points = pointsResult.results?.[0] || {};
    legacyRows.push({
      series_key: `legacy:${summary.event_name}`,
      event_name: summary.event_name,
      started_at: summary.started_at,
      points_json: points.points_json || '[]',
      point_count: points.point_count || 0,
      total_points: points.total_points || 0,
    });
  }
  let failSafeRows = [];
  try {
    const failSafeResult = await otherDb.prepare(FAILSAFE_SERIES_SQL).bind(fromTs, toTs).all();
    failSafeRows = failSafeResult.results || [];
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || ''))) throw error;
  }
  return {
    legacy: decodeSeriesRows(legacyRows, 'historical_import'),
    failSafe: decodeSeriesRows(failSafeRows, 'official_news_fail_safe'),
  };
}

async function loadBroadcastSeries(env, from, to) {
  const fromTs = parseDateStart(from);
  const toTs = addDays(parseDateStart(to), 1);
  const { legacy, failSafe } = await loadBroadcastSeriesRows(env.MINUTE_DB, env.OTHER_DB, fromTs, toTs);
  const trimmed = trimSeries(legacy.concat(failSafe));
  let failSafeEventCount = 0;
  for (const item of trimmed.series) {
    if (item.source === 'official_news_fail_safe') failSafeEventCount += 1;
  }
  return {
    ok: true, from, to, timezone: 'UTC', series: trimmed.series,
    event_count: trimmed.series.length, point_count: trimmed.pointCount,
    fail_safe_event_count: failSafeEventCount,
    truncated: trimmed.truncated, x_origin: 'broadcast_start', x_unit: 'minute',
  };
}

export async function onRequestGet({ request, env }) {
  if (!env.OTHER_DB || !env.MINUTE_DB) return json({ ok: false, error: 'history database bindings missing' }, 500);
  try {
    const url = new URL(request.url);
    const today = todayUtcString();
    const fromParam = url.searchParams.get('from');
    const toParam = url.searchParams.get('to');
    if ((fromParam && !isRealIsoDate(fromParam)) || (toParam && !isRealIsoDate(toParam))) {
      return json({ ok: false, error: 'from and to must be valid YYYY-MM-DD dates' }, 400);
    }
    const from = dateParam(fromParam, '2024-05-01');
    const to = dateParam(toParam, today);
    if (from > to) return json({ ok: false, error: 'from must not be after to' }, 400);
    const payload = await cachedBroadcastSeries(
      `broadcast-series:v3:${from}:${to}`,
      () => loadBroadcastSeries(env, from, to),
    );
    return json(payload);
  } catch (error) {
    return json({ ok: false, error: error?.message || 'broadcast series error' }, 500);
  }
}
