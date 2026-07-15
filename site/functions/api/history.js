import { onRequestGet as rawHistory } from './history-raw.js';
import { loadRanking } from './history-ranking.js';
import {
  SUMMARY_TABLES,
  combineSummaryRows,
  liveSummarySql,
  loadSummaryWithLive,
} from '../lib/history-summary.js';
import { isRealIsoDate } from '../lib/api-utils.js';

export { combineSummaryRows, liveSummarySql, loadSummaryWithLive };

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600',
  vary: 'accept-encoding',
};
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
const HISTORY_CACHE_MAX = 32;
const historyLoadCache = new Map();
export const BROADCAST_SESSION_GAP_MS = 6 * 60 * 60 * 1000;

function rankingCacheKey(url) {
  const from = url.searchParams.get('from') || '2024-06-01';
  const to = url.searchParams.get('to') || todayUtcString();
  const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'featured';
  const host = String(url.searchParams.get('host') || '').trim().slice(0, 100).toLowerCase();
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 5000, 20), 10000);
  return `ranking:v1:${from}:${to}:${scope}:${host}:${limit}`;
}

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
  return Date.parse(`${text}T00:00:00Z`);
}

const todayUtcString = () => new Date().toISOString().slice(0, 10);

export function broadcastSummarySql(source) {
  return `WITH eligible AS (
  SELECT id,observed_at,observed_jst,listener_count,track_title,artist_name,
    likes,host_handle,source_note,
    lower(trim(source_note)) AS event_key,
    lower(trim(host_handle)) AS host_key
  FROM ${source}
  WHERE observed_at>=? AND observed_at<?
    AND lower(trim(host_handle))='sakurazaka46jp'
    AND source_note IS NOT NULL AND trim(source_note)<>''
), ordered AS (
  SELECT eligible.*,
    LAG(event_key) OVER (
      PARTITION BY host_key ORDER BY observed_at ASC,id ASC
    ) AS previous_event_key,
    LAG(observed_at) OVER (
      PARTITION BY host_key ORDER BY observed_at ASC,id ASC
    ) AS previous_observed_at
  FROM eligible
), segmented AS (
  SELECT ordered.*,
    SUM(CASE
      WHEN previous_observed_at IS NULL
        OR previous_event_key<>event_key
        OR observed_at-previous_observed_at>?
      THEN 1 ELSE 0
    END) OVER (
      PARTITION BY host_key ORDER BY observed_at ASC,id ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS session_number
  FROM ordered
), summaries AS (
  SELECT MIN(trim(source_note)) AS event_name,MIN(observed_at) AS started_at,
    MAX(observed_at) AS ended_at,MIN(observed_jst) AS started_jst,MAX(observed_jst) AS ended_jst,
    COUNT(*) AS sample_count,ROUND(AVG(listener_count),1) AS listener_avg,
    MIN(listener_count) AS listener_min,MAX(listener_count) AS listener_max,MAX(likes) AS likes_max,
    COUNT(DISTINCT CASE
      WHEN trim(COALESCE(track_title,''))<>'' OR trim(COALESCE(artist_name,''))<>''
      THEN lower(trim(COALESCE(track_title,''))) || char(31) || lower(trim(COALESCE(artist_name,'')))
    END) AS distinct_tracks,
    MIN(trim(host_handle)) AS host_handle
  FROM segmented
  GROUP BY host_key,session_number
)
SELECT event_name,started_at,ended_at,started_jst,ended_jst,sample_count,
  listener_avg,listener_min,listener_max,likes_max,distinct_tracks,host_handle,1 AS has_data
FROM summaries
UNION ALL
SELECT NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
  EXISTS(SELECT 1 FROM ${source}
    WHERE lower(trim(host_handle))='sakurazaka46jp'
      AND source_note IS NOT NULL AND trim(source_note)<>'') AS has_data
WHERE NOT EXISTS (SELECT 1 FROM summaries)
ORDER BY started_at ASC`;
}

export const BROADCAST_SUMMARY_SQL = broadcastSummarySql('sh_legacy_history_rows');

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
  const toTs = parseDateStart(to, todayUtcString()) + 86400000;
  let result;
  let storageSource = 'lightweight';
  try {
    result = await env.OTHER_DB.prepare(BROADCAST_SUMMARY_SQL)
      .bind(fromTs, toTs, BROADCAST_SESSION_GAP_MS).all();
  } catch (error) {
    if (!/no such table|no such view/i.test(String(error?.message || ''))) throw error;
    return {
      ok: true,
      mode: 'broadcasts',
      from,
      to,
      rows: [],
      setup_required: true,
      storage_source: 'summary-only',
      diagnostic: { imported_rows: 0, imported_events: 0, first_observed_jst: null, last_observed_jst: null },
    };
  }
  const parsed = parseBroadcastSummaryRows(result.results || []);
  return {
    ok: true,
    mode: 'broadcasts',
    from,
    to,
    rows: parsed.rows,
    setup_required: parsed.setupRequired,
    storage_source: storageSource,
    diagnostic: {
      imported_rows: null,
      imported_events: null,
      first_observed_jst: null,
      last_observed_jst: null,
    },
  };
}

async function loadBroadcasts(env, from, to) {
  const payload = await cachedHistoryLoad(
    `broadcasts:v5:${from}:${to}`,
    30000,
    () => loadBroadcastPayload(env, from, to),
  );
  return json(payload, 200, {
    'cache-control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=120',
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, { 'cache-control': 'no-store' });
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode') || 'weekly';
  const fromParam = url.searchParams.get('from');
  const toParam = url.searchParams.get('to');
  const from = fromParam || '2024-06-01';
  const to = toParam || todayUtcString();
  try {
    if (mode !== 'raw' && ((fromParam && !isRealIsoDate(fromParam))
      || (toParam && !isRealIsoDate(toParam)))) {
      return json({ ok: false, error: 'from and to must be valid YYYY-MM-DD dates' }, 400, {
        'cache-control': 'no-store',
      });
    }
    if (mode !== 'raw' && from > to) {
      return json({ ok: false, error: 'from must not be after to' }, 400, {
        'cache-control': 'no-store',
      });
    }
    if (Object.hasOwn(SUMMARY_TABLES, mode)) {
      const summary = await cachedHistoryLoad(
        `summary:v4:${mode}:${from}:${to}`,
        30000,
        () => loadSummaryWithLive(env, mode, from, to),
      );
      return json({ ok: true, mode, from, to, ...summary }, 200, {
        'cache-control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=120',
      });
    }
    if (mode === 'ranking') {
      if (!env.OTHER_DB) return json({ ok: false, error: 'OTHER_DB binding missing' }, 500, { 'cache-control': 'no-store' });
      return cachedLegacyHistoryResponse(
        rankingCacheKey(url),
        30000,
        () => loadRanking(url, env, loadSummaryWithLive),
      );
    }
    if (mode === 'broadcasts') return loadBroadcasts(env, from, to);
    if (mode === 'raw') return rawHistory(context);
    return json({ ok: false, error: `unsupported history mode: ${mode}` }, 400, { 'cache-control': 'no-store' });
  } catch (error) {
    return json({ ok: false, error: error?.message || 'history error' }, 500, { 'cache-control': 'no-store' });
  }
}
