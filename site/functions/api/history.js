import { onRequestGet as legacyHistory } from './history-legacy.mjs';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600',
  vary: 'accept-encoding',
};
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
const SUMMARY_TABLES = { daily: 'sh_daily_summary', weekly: 'sh_weekly_summary', monthly: 'sh_monthly_summary' };
const SUMMARY_COLUMNS = `period_key,period_start,period_end,sample_count,reliable_sample_count,
listener_avg,listener_min,listener_max,stream_start,stream_end,stream_growth,
member_start,member_end,member_growth,likes_max,distinct_tracks,primary_host,
quality_score,quality_flags`;
const HISTORY_CACHE_MAX = 32;
const historyLoadCache = new Map();

function promoteCacheEntry(key, entry) {
  historyLoadCache.delete(key);
  historyLoadCache.set(key, entry);
}

export async function cachedHistoryLoad(key, ttlMs, loader, now = Date.now()) {
  const cached = historyLoadCache.get(key);
  if (cached?.expiresAt > now && Object.hasOwn(cached, 'value')) {
    promoteCacheEntry(key, cached);
    return cached.value;
  }
  if (cached?.pending) {
    promoteCacheEntry(key, cached);
    return cached.pending;
  }

  const entry = cached || {};
  entry.pending = Promise.resolve().then(loader).then((value) => {
    entry.value = value;
    entry.expiresAt = Date.now() + ttlMs;
    return value;
  }).catch((error) => {
    historyLoadCache.delete(key);
    throw error;
  }).finally(() => { entry.pending = null; });
  promoteCacheEntry(key, entry);
  while (historyLoadCache.size > HISTORY_CACHE_MAX) {
    historyLoadCache.delete(historyLoadCache.keys().next().value);
  }
  return entry.pending;
}

export function resetHistoryLoadCache() {
  historyLoadCache.clear();
}

async function snapshotResponse(response) {
  return {
    body: await response.text(),
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
  };
}

function restoreResponse(snapshot) {
  return new Response(snapshot.body, {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: snapshot.headers,
  });
}

export async function cachedLegacyHistoryResponse(key, ttlMs, loader) {
  try {
    const snapshot = await cachedHistoryLoad(key, ttlMs, async () => {
      const response = await loader();
      const value = await snapshotResponse(response);
      if (!response.ok) {
        const error = new Error(`history response ${response.status}`);
        error.responseSnapshot = value;
        throw error;
      }
      return value;
    });
    return restoreResponse(snapshot);
  } catch (error) {
    if (error?.responseSnapshot) return restoreResponse(error.responseSnapshot);
    throw error;
  }
}

function parseDateStart(value, fallback) {
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : fallback;
  return Date.parse(`${text}T00:00:00+09:00`);
}
const addDays = (timestamp, days) => timestamp + days * 86400000;
const todayJstString = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function periodExpression(mode) {
  if (mode === 'daily') return `strftime('%Y-%m-%d', observed_at / 1000, 'unixepoch', '+9 hours')`;
  if (mode === 'monthly') return `strftime('%Y-%m', observed_at / 1000, 'unixepoch', '+9 hours')`;
  return `date(observed_at / 1000,'unixepoch','+9 hours','-' || ((CAST(strftime('%w', observed_at / 1000, 'unixepoch', '+9 hours') AS INTEGER) + 6) % 7) || ' days')`;
}

export function liveSummarySql(mode) {
  const periodKey = periodExpression(mode);
  return `WITH prepared AS (
    SELECT id,observed_at,listener_count,total_member_count,
      COALESCE(current_stream_count,total_listens) AS stream_value,host_handle,
      ${periodKey} AS period_key
    FROM sh_channel_snapshots WHERE observed_at>=? AND observed_at<?
  ), ranked AS (
    SELECT prepared.*,
      ROW_NUMBER() OVER (
        PARTITION BY period_key
        ORDER BY (stream_value IS NULL) ASC,observed_at ASC,id ASC
      ) AS stream_first_rank,
      ROW_NUMBER() OVER (
        PARTITION BY period_key
        ORDER BY (stream_value IS NULL) ASC,observed_at DESC,id DESC
      ) AS stream_last_rank,
      ROW_NUMBER() OVER (
        PARTITION BY period_key
        ORDER BY (total_member_count IS NULL) ASC,observed_at ASC,id ASC
      ) AS member_first_rank,
      ROW_NUMBER() OVER (
        PARTITION BY period_key
        ORDER BY (total_member_count IS NULL) ASC,observed_at DESC,id DESC
      ) AS member_last_rank
    FROM prepared
  ), aggregated AS (
    SELECT period_key,MIN(observed_at) AS period_start,MAX(observed_at) AS period_end,
      COUNT(*) AS sample_count,AVG(listener_count) AS listener_avg,
      MIN(listener_count) AS listener_min,MAX(listener_count) AS listener_max,
      MAX(CASE WHEN stream_first_rank=1 THEN stream_value END) AS stream_start,
      MAX(CASE WHEN stream_last_rank=1 THEN stream_value END) AS stream_end,
      MAX(CASE WHEN member_first_rank=1 THEN total_member_count END) AS member_start,
      MAX(CASE WHEN member_last_rank=1 THEN total_member_count END) AS member_end
    FROM ranked GROUP BY period_key
  ), host_counts AS (
    SELECT period_key,host_handle,COUNT(*) AS host_samples FROM prepared
    WHERE host_handle IS NOT NULL AND host_handle<>'' GROUP BY period_key,host_handle
  ), primary_hosts AS (
    SELECT period_key,host_handle FROM (
      SELECT period_key,host_handle,ROW_NUMBER() OVER (
        PARTITION BY period_key ORDER BY host_samples DESC,host_handle ASC
      ) AS host_rank FROM host_counts
    ) WHERE host_rank=1
  )
  SELECT aggregated.period_key,aggregated.period_start,aggregated.period_end,
    aggregated.sample_count,aggregated.sample_count AS reliable_sample_count,
    aggregated.listener_avg,aggregated.listener_min,aggregated.listener_max,
    aggregated.stream_start,aggregated.stream_end,
    aggregated.member_start,aggregated.member_end,
    primary_hosts.host_handle AS primary_host
  FROM aggregated LEFT JOIN primary_hosts ON primary_hosts.period_key=aggregated.period_key
  ORDER BY aggregated.period_key ASC LIMIT ?`;
}

function normalizeLiveRow(row) {
  const streamStart = finiteNumber(row.stream_start);
  const streamEnd = finiteNumber(row.stream_end);
  const memberStart = finiteNumber(row.member_start);
  const memberEnd = finiteNumber(row.member_end);
  return {
    ...row,
    stream_growth: streamStart != null && streamEnd != null && streamEnd >= streamStart ? streamEnd - streamStart : null,
    member_growth: memberStart != null && memberEnd != null ? memberEnd - memberStart : null,
    likes_max: null, distinct_tracks: null, quality_score: 1,
    quality_flags: '["live_collector"]', live_collector: true,
  };
}

export function combineSummaryRows(base, live) {
  if (!base) return live;
  if (!live) return base;
  const extrema = (values, mode) => {
    const valid = values.map(finiteNumber).filter((value) => value != null);
    if (!valid.length) return null;
    return mode === 'min' ? Math.min(...valid) : Math.max(...valid);
  };
  const weightedAverage = (a, aCount, b, bCount) => {
    const av = finiteNumber(a); const bv = finiteNumber(b);
    if (av == null) return bv; if (bv == null) return av;
    return (av * aCount + bv * bCount) / Math.max(1, aCount + bCount);
  };
  const baseCount = finiteNumber(base.reliable_sample_count) || finiteNumber(base.sample_count) || 0;
  const liveCount = finiteNumber(live.reliable_sample_count) || finiteNumber(live.sample_count) || 0;
  const streamStart = finiteNumber(base.stream_start) ?? finiteNumber(live.stream_start);
  const streamEnd = finiteNumber(live.stream_end) ?? finiteNumber(base.stream_end);
  const memberStart = finiteNumber(base.member_start) ?? finiteNumber(live.member_start);
  const memberEnd = finiteNumber(live.member_end) ?? finiteNumber(base.member_end);
  return {
    ...base, ...live,
    period_start: Math.min(finiteNumber(base.period_start) ?? Infinity, finiteNumber(live.period_start) ?? Infinity),
    period_end: Math.max(finiteNumber(base.period_end) ?? 0, finiteNumber(live.period_end) ?? 0),
    sample_count: (finiteNumber(base.sample_count) || 0) + (finiteNumber(live.sample_count) || 0),
    reliable_sample_count: baseCount + liveCount,
    listener_avg: weightedAverage(base.listener_avg, baseCount, live.listener_avg, liveCount),
    listener_min: extrema([base.listener_min, live.listener_min], 'min'),
    listener_max: extrema([base.listener_max, live.listener_max], 'max'),
    stream_start: streamStart, stream_end: streamEnd,
    stream_growth: streamStart != null && streamEnd != null && streamEnd >= streamStart ? streamEnd - streamStart : null,
    member_start: memberStart, member_end: memberEnd,
    member_growth: memberStart != null && memberEnd != null ? memberEnd - memberStart : null,
    primary_host: live.primary_host || base.primary_host,
    quality_flags: '["historical_import","live_collector"]', live_collector: true,
  };
}

async function loadSummaryWithLive(env, mode, from, to) {
  const table = SUMMARY_TABLES[mode] || SUMMARY_TABLES.weekly;
  const limit = mode === 'daily' ? 800 : mode === 'weekly' ? 160 : 60;
  const baseResult = await env.DB.prepare(
    `SELECT ${SUMMARY_COLUMNS} FROM ${table} WHERE period_key>=? AND period_key<=? ORDER BY period_key ASC LIMIT ?`,
  ).bind(from, to, limit).all();
  const baseRows = baseResult.results || [];
  const fromTs = parseDateStart(from, '2024-06-01');
  const toTs = addDays(parseDateStart(to, todayJstString()), 1);
  const lastBaseEnd = finiteNumber(baseRows.at(-1)?.period_end);
  const liveStart = Math.max(fromTs, lastBaseEnd == null ? fromTs : lastBaseEnd + 1);
  const liveResult = liveStart < toTs
    ? await env.DB.prepare(liveSummarySql(mode)).bind(liveStart, toTs, limit).all()
    : { results: [] };
  const liveRows = (liveResult.results || []).map(normalizeLiveRow);
  const merged = new Map(baseRows.map((row) => [row.period_key, row]));
  liveRows.forEach((row) => merged.set(row.period_key, combineSummaryRows(merged.get(row.period_key), row)));
  return {
    rows: [...merged.values()].slice(-limit),
    live_overlay_count: liveRows.length,
    latest_live_observed_at: liveRows.at(-1)?.period_end || null,
    live_truncated: false,
  };
}

export const BROADCAST_SUMMARY_SQL = `WITH summaries AS (
  SELECT source_note AS event_name,MIN(observed_at) AS started_at,
    MAX(observed_at) AS ended_at,MIN(observed_jst) AS started_jst,MAX(observed_jst) AS ended_jst,
    COUNT(*) AS sample_count,ROUND(AVG(listener_count),1) AS listener_avg,
    MIN(listener_count) AS listener_min,MAX(listener_count) AS listener_max,MAX(likes) AS likes_max,
    COUNT(DISTINCT CASE WHEN track_title IS NOT NULL AND track_title<>'' THEN track_title END) AS distinct_tracks,
    host_handle
  FROM sh_legacy_snapshots
  WHERE observed_at>=? AND observed_at<? AND host_handle='sakurazaka46jp' AND source_note IS NOT NULL
  GROUP BY source_note,host_handle
)
SELECT event_name,started_at,ended_at,started_jst,ended_jst,sample_count,
  listener_avg,listener_min,listener_max,likes_max,distinct_tracks,host_handle,1 AS has_data
FROM summaries
UNION ALL
SELECT NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
  EXISTS(SELECT 1 FROM sh_legacy_snapshots
    WHERE host_handle='sakurazaka46jp' AND source_note IS NOT NULL) AS has_data
WHERE NOT EXISTS (SELECT 1 FROM summaries)
ORDER BY started_at ASC`;

export function parseBroadcastSummaryRows(resultRows) {
  const rows = [];
  let hasData = false;
  for (const source of resultRows || []) {
    if (Number(source?.has_data) === 1) hasData = true;
    if (source?.event_name == null) continue;
    const { has_data: ignored, ...row } = source;
    rows.push(row);
  }
  return { rows, setupRequired: rows.length === 0 && !hasData };
}

async function loadBroadcastPayload(env, from, to) {
  const fromTs = parseDateStart(from, '2024-06-01');
  const toTs = addDays(parseDateStart(to, todayJstString()), 1);
  const result = await env.DB.prepare(BROADCAST_SUMMARY_SQL).bind(fromTs, toTs).all();
  const parsed = parseBroadcastSummaryRows(result.results || []);
  return {
    ok: true, mode: 'broadcasts', from, to, rows: parsed.rows,
    setup_required: parsed.setupRequired,
    diagnostic: { imported_rows: null, imported_events: null, first_observed_jst: null, last_observed_jst: null },
  };
}

async function loadBroadcasts(env, from, to) {
  const payload = await cachedHistoryLoad(
    `broadcasts:v2:${from}:${to}`,
    30000,
    () => loadBroadcastPayload(env, from, to),
  );
  return json(payload, 200, { 'cache-control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=120' });
}

function rankingCacheKey(url) {
  const from = url.searchParams.get('from') || '2024-06-01';
  const to = url.searchParams.get('to') || todayJstString();
  const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'featured';
  const host = String(url.searchParams.get('host') || '').trim().slice(0, 100).toLowerCase();
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 5000, 20), 10000);
  const version = String(url.searchParams.get('v') || '');
  return `ranking:v2:${from}:${to}:${scope}:${host}:${limit}:${version}`;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, { 'cache-control': 'no-store' });
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode') || 'weekly';
  const from = url.searchParams.get('from') || '2024-06-01';
  const to = url.searchParams.get('to') || todayJstString();
  try {
    if (Object.hasOwn(SUMMARY_TABLES, mode)) {
      const summary = await cachedHistoryLoad(
        `summary:v2:${mode}:${from}:${to}`,
        30000,
        () => loadSummaryWithLive(env, mode, from, to),
      );
      return json({ ok: true, mode, from, to, ...summary }, 200, {
        'cache-control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=120',
      });
    }
    if (mode === 'broadcasts') return loadBroadcasts(env, from, to);
    if (mode === 'ranking') {
      return cachedLegacyHistoryResponse(rankingCacheKey(url), 60000, () => legacyHistory(context));
    }
    return legacyHistory(context);
  } catch (error) {
    return json({ ok: false, error: error?.message || 'history error' }, 500, { 'cache-control': 'no-store' });
  }
}
