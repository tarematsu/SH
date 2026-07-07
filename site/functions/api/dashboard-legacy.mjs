import { num } from '../lib/api-utils.js';
import {
  computePlayback as computePlaybackWithAnchors,
  normalizePlaybackTrack,
  safeJson,
} from '../lib/playback.js';
import { LATEST_QUEUE_WITH_ITEMS_SQL, parseLatestQueueRows } from '../lib/latest-queue.js';

const json = (data, status = 200, cache = 'public, max-age=20, s-maxage=30, stale-while-revalidate=90') =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cache,
      'vary': 'accept-encoding',
    },
  });

function jstDayRange(now = Date.now(), cutoffHour = 0) {
  const shifted = new Date(now + 9 * 3600000);
  let currentStart = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    cutoffHour,
  ) - 9 * 3600000;
  if (now < currentStart) currentStart -= 86400000;
  return { previousStart: currentStart - 86400000, currentStart };
}

export function hostScopeFromSnapshot(snapshot) {
  const hostAccountIdRaw = snapshot?.host_account_id;
  const hostAccountId = hostAccountIdRaw === undefined || hostAccountIdRaw === null || hostAccountIdRaw === ''
    ? null
    : Number(hostAccountIdRaw);
  if (Number.isFinite(hostAccountId) && hostAccountId > 0) {
    return { column: 'host_account_id', value: hostAccountId };
  }

  const hostHandle = String(snapshot?.host_handle || '').trim();
  if (hostHandle) {
    return { column: 'host_handle', value: hostHandle };
  }

  return null;
}

function hostScopedLatestSql(metricColumn, hostScope) {
  const hostClause = hostScope ? ` AND ${hostScope.column} = ?` : '';
  return `SELECT observed_at,${metricColumn}
FROM sh_channel_snapshots
WHERE observed_at>=? AND observed_at<?${hostClause}
ORDER BY observed_at DESC,id DESC LIMIT 1`;
}

function hostScopedBinds(hostScope, start, end) {
  return hostScope ? [start, end, hostScope.value] : [start, end];
}

const HOST_METRIC_CACHE_MS = 15 * 60 * 1000;
const hostMetricCache = new Map();

function hostMetricCacheKey(metricColumn, hostScope, start, end) {
  return [metricColumn, hostScope?.column || '', hostScope?.value || '', start, end].join(':');
}

export async function cachedHostMetric(db, metricColumn, hostScope, start, end, now = Date.now()) {
  if (!['total_member_count', 'total_listens'].includes(metricColumn)) {
    throw new Error(`unsupported host metric: ${metricColumn}`);
  }
  const key = hostMetricCacheKey(metricColumn, hostScope, start, end);
  const cached = hostMetricCache.get(key);
  if (cached?.expiresAt > now && Object.hasOwn(cached, 'value')) return cached.value;
  if (cached?.pending) return cached.pending;

  const entry = cached || {};
  entry.pending = db.prepare(hostScopedLatestSql(metricColumn, hostScope))
    .bind(...hostScopedBinds(hostScope, start, end))
    .first()
    .then((value) => {
      entry.value = value || null;
      entry.expiresAt = Date.now() + HOST_METRIC_CACHE_MS;
      return entry.value;
    })
    .finally(() => { entry.pending = null; });
  hostMetricCache.set(key, entry);
  while (hostMetricCache.size > 16) hostMetricCache.delete(hostMetricCache.keys().next().value);
  return entry.pending;
}

export function resetHostMetricCache() {
  hostMetricCache.clear();
}

export function linearRegressionPrediction(rows, goal, now = Date.now()) {
  const points = rows.map((r) => ({ t: num(r.observed_at), y: num(r.current_stream_count) }))
    .filter((p) => p.t != null && p.y != null).sort((a, b) => a.t - b.t);
  if (!goal || points.length < 5) return null;
  const firstT = points[0].t;
  const spanMs = points.at(-1).t - firstT;
  if (spanMs < 15 * 60000) return null;
  const xs = points.map((p) => (p.t - firstT) / 3600000);
  const ys = points.map((p) => p.y);
  const xMean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0; let varX = 0;
  for (let i = 0; i < xs.length; i += 1) {
    cov += (xs[i] - xMean) * (ys[i] - yMean);
    varX += (xs[i] - xMean) ** 2;
  }
  if (varX <= 0) return null;
  const ratePerHour = cov / varX;
  if (!Number.isFinite(ratePerHour) || ratePerHour <= 0) return null;
  const latest = points.at(-1).y;
  const remaining = Math.max(0, goal - latest);
  return {
    eta: remaining === 0 ? now : now + (remaining / ratePerHour) * 3600000,
    rate_per_hour: ratePerHour,
    remaining,
    sample_count: points.length,
    span_hours: spanMs / 3600000,
  };
}

export function linearRegressionPredictionFromAggregate(row, goal, now = Date.now()) {
  const sampleCount = num(row?.sample_count);
  const firstT = num(row?.first_t);
  const lastT = num(row?.last_t);
  const xMean = num(row?.x_mean);
  const yMean = num(row?.y_mean);
  const xyMean = num(row?.xy_mean);
  const xxMean = num(row?.xx_mean);
  const latest = num(row?.latest_y);
  if (!goal || sampleCount == null || sampleCount < 5 || firstT == null || lastT == null || latest == null) return null;
  const spanMs = lastT - firstT;
  if (spanMs < 15 * 60000 || [xMean, yMean, xyMean, xxMean].some((value) => value == null)) return null;
  const covariance = xyMean - xMean * yMean;
  const variance = xxMean - xMean * xMean;
  if (!Number.isFinite(variance) || variance <= 0) return null;
  const ratePerHour = covariance / variance;
  if (!Number.isFinite(ratePerHour) || ratePerHour <= 0) return null;
  const remaining = Math.max(0, goal - latest);
  return {
    eta: remaining === 0 ? now : now + (remaining / ratePerHour) * 3600000,
    rate_per_hour: ratePerHour,
    remaining,
    sample_count: sampleCount,
    span_hours: spanMs / 3600000,
  };
}

const LATEST_SQL = `SELECT
  id,observed_at,channel_id,channel_alias,channel_name,station_id,
  is_launched,is_broadcasting,chat_status,listener_count,online_member_count,
  total_member_count,guest_count,total_listens,stream_goal,current_stream_count,
  host_account_id,host_handle,broadcast_start_time,comment_velocity,raw_json
FROM sh_channel_snapshots ORDER BY observed_at DESC,id DESC LIMIT 1`;

export const HISTORY_24H_SQL = `WITH ranked AS (
  SELECT id,observed_at,listener_count,online_member_count,total_member_count,
    total_listens,current_stream_count,stream_goal,
    MAX(COALESCE(comment_velocity, 0)) OVER (
      PARTITION BY CAST(observed_at/300000 AS INTEGER)
    ) AS comment_velocity_max,
    ROW_NUMBER() OVER (
      PARTITION BY CAST(observed_at/300000 AS INTEGER)
      ORDER BY observed_at DESC,id DESC
    ) AS rn
  FROM sh_channel_snapshots
  WHERE observed_at >= (unixepoch('now','-24 hours')*1000)
)
SELECT observed_at,listener_count,online_member_count,total_member_count,
  total_listens,current_stream_count,stream_goal,comment_velocity_max AS comment_velocity
FROM ranked WHERE rn=1 ORDER BY observed_at ASC LIMIT 300`;

export const PREDICTION_24H_SQL = `WITH ranked AS (
  SELECT id,observed_at,current_stream_count,
    ROW_NUMBER() OVER (
      PARTITION BY CAST(observed_at/300000 AS INTEGER)
      ORDER BY observed_at DESC,id DESC
    ) AS bucket_rank
  FROM sh_channel_snapshots
  WHERE observed_at >= (unixepoch('now','-24 hours')*1000)
    AND current_stream_count IS NOT NULL
), points AS (
  SELECT observed_at,
    CAST(current_stream_count AS REAL) AS y,
    (observed_at - MIN(observed_at) OVER ()) / 3600000.0 AS x,
    ROW_NUMBER() OVER (ORDER BY observed_at DESC,id DESC) AS latest_rank
  FROM ranked
  WHERE bucket_rank=1
)
SELECT COUNT(*) AS sample_count,
  MIN(observed_at) AS first_t,
  MAX(observed_at) AS last_t,
  AVG(x) AS x_mean,
  AVG(y) AS y_mean,
  AVG(x*y) AS xy_mean,
  AVG(x*x) AS xx_mean,
  MAX(CASE WHEN latest_rank=1 THEN y END) AS latest_y
FROM points`;

function publicLatest(latest, channel, station, owner, goal) {
  if (!latest) return null;
  return {
    observed_at: latest.observed_at,
    channel_id: latest.channel_id,
    channel_alias: latest.channel_alias,
    channel_name: latest.channel_name,
    station_id: latest.station_id,
    is_launched: latest.is_launched,
    is_broadcasting: latest.is_broadcasting,
    chat_status: latest.chat_status,
    listener_count: latest.listener_count,
    online_member_count: latest.online_member_count,
    total_member_count: latest.total_member_count,
    guest_count: latest.guest_count,
    total_listens: latest.total_listens,
    stream_goal: goal,
    current_stream_count: latest.current_stream_count ?? station?.streaming_party?.current_stream_count ?? null,
    host_account_id: latest.host_account_id,
    host_handle: latest.host_handle,
    broadcast_start_time: latest.broadcast_start_time,
    comment_velocity: latest.comment_velocity,
    description: channel.description || station.status || null,
    artist_name: channel.artist_name || null,
    accent_color: channel.accent_color || null,
    channel_image: channel.images?.medium?.url || null,
    logo_image: channel.images?.logo?.medium?.url || null,
    host_image: owner.thumbnail?.url || owner.medium?.url || null,
  };
}

function compactQueueStatus(latestQueue, latest, playback, totalItems) {
  if (!latestQueue) return null;
  const playing = latest?.is_broadcasting !== 0
    && latest?.is_broadcasting !== false
    && !latestQueue.is_paused
    && playback.currentIndex >= 0;
  return {
    is_paused: Boolean(latestQueue.is_paused),
    playing,
    current_index: playback.currentIndex,
    progress_ms: playback.progressMs,
    anchor_at: playback.anchorAt,
    queue_end_at: playback.queueEndAt,
    total_items: totalItems,
  };
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ ok: false, error: 'DB binding missing' }, 500, 'no-store');
  try {
    const url = new URL(request.url);
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
    const includeHistory = url.searchParams.get('history') !== '0';
    const initial = since <= 0;
    const listensRange = jstDayRange(Date.now(), 9);
    const memberRange = jstDayRange(Date.now(), 16);

    const historyStatement = !includeHistory
      ? null
      : initial
        ? db.prepare(HISTORY_24H_SQL)
        : db.prepare(`SELECT observed_at,listener_count,online_member_count,total_member_count,
            total_listens,current_stream_count,stream_goal,comment_velocity
          FROM sh_channel_snapshots WHERE observed_at>?
          ORDER BY observed_at ASC,id ASC LIMIT 180`).bind(since);

    const predictionStatement = initial && includeHistory ? null : db.prepare(PREDICTION_24H_SQL);
    const [latest, historyResult, queueResult, predictionResult] = await Promise.all([
      db.prepare(LATEST_SQL).first(),
      historyStatement ? historyStatement.all() : Promise.resolve({ results: [] }),
      db.prepare(LATEST_QUEUE_WITH_ITEMS_SQL).all(),
      predictionStatement ? predictionStatement.first() : Promise.resolve(null),
    ]);

    const hostScope = hostScopeFromSnapshot(latest);
    const [previousMembers, previousListens] = await Promise.all([
      cachedHostMetric(db, 'total_member_count', hostScope, memberRange.previousStart, memberRange.currentStart),
      cachedHostMetric(db, 'total_listens', hostScope, listensRange.previousStart, listensRange.currentStart),
    ]);

    const history = historyResult.results || [];
    const { latestQueue, queue } = parseLatestQueueRows(queueResult.results || []);

    const generatedAt = Date.now();
    const playback = computePlaybackWithAnchors(queue, generatedAt);
    const startIndex = Math.max(0, playback.currentIndex);
    const enrichedQueue = queue.slice(startIndex).map((track, index) => (
      normalizePlaybackTrack(track, startIndex + index, playback)
    ));

    const channel = safeJson(latest?.raw_json, {}) || {};
    const station = channel.current_station || {};
    const owner = station.owner || {};
    const streaming = station.streaming_party || {};
    const goal = latest?.stream_goal ?? streaming.stream_goal ?? null;
    const goalPrediction = initial && includeHistory
      ? linearRegressionPrediction(history, num(goal), generatedAt)
      : linearRegressionPredictionFromAggregate(predictionResult, num(goal), generatedAt);

    return json({
      ok: true,
      generated_at: generatedAt,
      delta: !initial,
      history_deferred: initial && !includeHistory,
      latest_observed_at: latest?.observed_at || since,
      latest: publicLatest(latest, channel, station, owner, goal),
      history,
      daily_change: latest ? {
        host_account_id: latest.host_account_id ?? null,
        host_handle: latest.host_handle ?? null,
        member_baseline_observed_at: previousMembers?.observed_at || null,
        listens_baseline_observed_at: previousListens?.observed_at || null,
        member_cutoff_hour_jst: 16,
        listens_cutoff_hour_jst: 9,
        total_member_count: previousMembers && num(latest.total_member_count) != null && num(previousMembers.total_member_count) != null
          ? num(latest.total_member_count) - num(previousMembers.total_member_count) : null,
        total_listens: previousListens && num(latest.total_listens) != null && num(previousListens.total_listens) != null
          ? num(latest.total_listens) - num(previousListens.total_listens) : null,
      } : null,
      goal_prediction: goalPrediction,
      queue: enrichedQueue,
      queue_status: compactQueueStatus(latestQueue, latest, playback, queue.length),
    });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'dashboard error' }, 500, 'no-store');
  }
}
