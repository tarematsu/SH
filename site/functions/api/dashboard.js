import {
  hostScopeFromSnapshot,
  linearRegressionPrediction,
  linearRegressionPredictionFromAggregate,
  dashboardGoalTargets,
  dashboardGoalPredictions,
  cachedHostMetric,
  resetHostMetricCache,
  commentVelocityExpression,
  HISTORY_24H_SQL,
  PREDICTION_24H_SQL,
  publicLatest,
  compactQueueStatus,
} from './dashboard-legacy.mjs';
import { LATEST_QUEUE_WITH_ITEMS_SQL, parseLatestQueueRows } from '../lib/latest-queue.js';
import { num } from '../lib/api-utils.js';
import { computePlayback, normalizePlaybackTrack } from '../lib/playback.js';
import {
  factsAreFresh,
  loadFactsBaseline,
  loadFactsDashboard,
} from '../lib/dashboard-facts.js';
import { loadPublicReadModels, presentationFromRow, queueFromReadModel } from '../lib/public-read-model.js';
import {
  hostIdentity,
  parseQueueState,
  queueRevision,
  stateFromQueue,
} from '../lib/queue-state.js';

export {
  hostScopeFromSnapshot,
  linearRegressionPrediction,
  linearRegressionPredictionFromAggregate,
  dashboardGoalTargets,
  dashboardGoalPredictions,
  cachedHostMetric,
  resetHostMetricCache,
  HISTORY_24H_SQL,
  PREDICTION_24H_SQL,
};

export const PREDICTION_STATE_SQL = `SELECT
  generated_at,source_observed_at,goal,eta,rate_per_hour,remaining,
  sample_count,span_hours,next_refresh_at,last_error,updated_at
FROM sh_stream_goal_prediction_state
WHERE id='stream-goal-24h'
LIMIT 1`;

const cache = { value: null, hasValue: false, expiresAt: 0 };

export async function cachedPrediction(statement, now = Date.now()) {
  if (cache.hasValue && cache.expiresAt > now) return cache.value;
  const value = await statement.first();
  cache.value = value ?? null;
  cache.hasValue = true;
  cache.expiresAt = Date.now() + 60000;
  return cache.value;
}

export function resetPredictionCache() {
  cache.value = null;
  cache.hasValue = false;
  cache.expiresAt = 0;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function predictionFromPersistedState(row, currentGoal) {
  const generatedAt = finite(row?.generated_at);
  const goal = finite(row?.goal);
  const eta = finite(row?.eta);
  const ratePerHour = finite(row?.rate_per_hour);
  const remaining = finite(row?.remaining);
  if (generatedAt == null || generatedAt <= 0) return null;
  if (currentGoal != null && goal != null && currentGoal !== goal) return null;
  if (eta == null || ratePerHour == null || ratePerHour <= 0 || remaining == null) return null;
  return {
    goal,
    eta,
    rate_per_hour: ratePerHour,
    remaining,
    sample_count: finite(row?.sample_count) ?? 0,
    span_hours: finite(row?.span_hours) ?? 0,
    generated_at: generatedAt,
    source_observed_at: finite(row?.source_observed_at),
  };
}

export function selectGoalPrediction(persistedRow, calculatedPrediction, currentGoal) {
  return predictionFromPersistedState(persistedRow, currentGoal)
    || calculatedPrediction
    || null;
}

export function mergeGoalPredictions(calculatedPredictions, selectedPrediction, currentGoal) {
  const predictions = Array.isArray(calculatedPredictions)
    ? calculatedPredictions.map((prediction) => ({ ...prediction }))
    : [];
  const goal = finite(currentGoal);
  if (!selectedPrediction || goal == null) return predictions;

  const selected = { ...selectedPrediction, goal };
  const index = predictions.findIndex((prediction) => finite(prediction?.goal) === goal);
  if (index >= 0) predictions[index] = selected;
  else predictions.unshift(selected);
  return predictions.sort((left, right) => finite(left?.goal) - finite(right?.goal));
}

async function loadPredictionState(db) {
  if (!db) return null;
  try {
    return await cachedPrediction(db.prepare(PREDICTION_STATE_SQL));
  } catch (error) {
    if (/no such table:\s*sh_stream_goal_prediction_state/i.test(String(error?.message || error))) {
      return null;
    }
    throw error;
  }
}

export const DASHBOARD_CONTEXT_SQL = `WITH latest_channel AS (
  SELECT
    id,observed_at,channel_id,channel_alias,channel_name,station_id,
    is_launched,is_broadcasting,chat_status,listener_count,online_member_count,
    total_member_count,guest_count,total_listens,stream_goal,current_stream_count,
    host_account_id,host_handle,broadcast_start_time,
    ${commentVelocityExpression('snapshots')} AS comment_velocity,snapshots.raw_json
  FROM sh_channel_snapshots AS snapshots
  ORDER BY snapshots.observed_at DESC,snapshots.id DESC
  LIMIT 1
), station_queue AS (
  SELECT station_id,queue_id,start_time,is_paused,observed_at,
    structural_hash,likes_hash,0 AS priority
  FROM sh_queue_current
  WHERE station_id=(SELECT station_id FROM latest_channel)
), recent_queue AS (
  SELECT station_id,queue_id,start_time,is_paused,observed_at,
    structural_hash,likes_hash,1 AS priority
  FROM sh_queue_current
  ORDER BY observed_at DESC
  LIMIT 1
), latest_queue AS (
  SELECT station_id,queue_id,start_time,is_paused,observed_at,
    structural_hash,likes_hash
  FROM (
    SELECT * FROM station_queue
    UNION ALL
    SELECT * FROM recent_queue
  )
  ORDER BY priority ASC,observed_at DESC
  LIMIT 1
), queue_stats AS (
  SELECT
    MAX(items.observed_at) AS item_observed_at,
    MAX(metadata.fetched_at) AS metadata_fetched_at,
    COUNT(items.position) AS total_items
  FROM latest_queue
  LEFT JOIN sh_queue_items items
    ON items.station_id=latest_queue.station_id
    AND items.start_time=latest_queue.start_time
  LEFT JOIN sh_track_metadata metadata ON metadata.spotify_id=items.spotify_id
)
SELECT
  latest_channel.*,
  latest_queue.station_id AS queue_station_id,
  latest_queue.queue_id,
  latest_queue.start_time AS queue_start_time,
  latest_queue.is_paused AS queue_is_paused,
  latest_queue.observed_at AS queue_observed_at,
  latest_queue.structural_hash,
  latest_queue.likes_hash,
  queue_stats.item_observed_at,
  queue_stats.metadata_fetched_at,
  queue_stats.total_items
FROM latest_channel
LEFT JOIN latest_queue ON 1=1
LEFT JOIN queue_stats ON 1=1`;

function latestSnapshotSql(sql) {
  const value = String(sql || '').replace(/\s+/g, ' ');
  return value.includes('comment_velocity')
    && value.includes('raw_json')
    && value.includes('FROM sh_channel_snapshots')
    && value.includes('ORDER BY')
    && value.includes('observed_at DESC')
    && value.includes('id DESC LIMIT 1');
}

export async function loadDashboardContext(db, queueContext) {
  if (!queueContext.contextPromise) {
    queueContext.contextPromise = db.prepare(DASHBOARD_CONTEXT_SQL).first().then((row) => {
      queueContext.state = parseQueueState(row);
      queueContext.hostIdentity = hostIdentity(row);
      queueContext.revision = queueRevision(queueContext.state, queueContext.hostIdentity);
      return row || null;
    }).catch((error) => {
      queueContext.contextPromise = null;
      throw error;
    });
  }
  return queueContext.contextPromise;
}

function queueHeaderResult(state) {
  if (!state) return { results: [] };
  return { results: [{
    queue_station_id: state.station_id,
    queue_id: state.queue_id,
    queue_start_time: state.start_time,
    queue_is_paused: state.is_paused,
    queue_observed_at: state.observed_at,
    structural_hash: state.structural_hash,
    likes_hash: state.likes_hash,
    position: null,
  }] };
}

export async function loadDashboardQueue(statement, db, queueContext) {
  if (!queueContext.requestedRevision) {
    const result = await statement.all();
    const parsed = parseLatestQueueRows(result.results || []);
    queueContext.state = stateFromQueue(parsed.latestQueue, parsed.queue);
    return result;
  }

  await loadDashboardContext(db, queueContext);
  if (queueContext.revision === queueContext.requestedRevision) {
    queueContext.unchanged = true;
    return queueHeaderResult(queueContext.state);
  }
  return statement.all();
}

function captureHostIdentity(value, queueContext) {
  const identity = hostIdentity(value);
  if (identity) queueContext.hostIdentity = identity;
  return value;
}

function proxyStatement(statement, sql, db, queueContext) {
  return new Proxy(statement, {
    get(target, property) {
      if (sql === LATEST_QUEUE_WITH_ITEMS_SQL && property === 'all') {
        return () => loadDashboardQueue(target, db, queueContext);
      }
      if (property === 'first' && queueContext.requestedRevision && latestSnapshotSql(sql)) {
        return () => loadDashboardContext(db, queueContext);
      }
      if (property === 'first') {
        return async (...args) => captureHostIdentity(await target.first(...args), queueContext);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function proxyDatabase(db, queueContext) {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => proxyStatement(target.prepare(sql), sql, target, queueContext);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function queueResponseFields(queueContext) {
  return {
    queue_revision: queueContext.revision
      || queueRevision(queueContext.state, queueContext.hostIdentity),
    queue_unchanged: Boolean(queueContext.unchanged),
  };
}

export function appendJsonObjectFields(body, fields) {
  const text = String(body || '');
  const trimmed = text.trim();
  const encoded = JSON.stringify(fields || {}).slice(1, -1);
  if (!encoded || !trimmed.startsWith('{') || !trimmed.endsWith('}')) return text;
  const closing = text.lastIndexOf('}');
  return `${text.slice(0, closing)}${trimmed === '{}' ? '' : ','}${encoded}${text.slice(closing)}`;
}

export function decorateQueueResponse(payload, queueContext) {
  if (!payload?.ok) return payload;
  const result = { ...payload, ...queueResponseFields(queueContext) };
  if (!queueContext.unchanged) return result;
  result.queue = [];
  if (result.queue_status) {
    result.queue_status = {
      ...result.queue_status,
      playing: result.latest?.is_broadcasting !== 0
        && result.latest?.is_broadcasting !== false
        && !result.queue_status.is_paused,
      total_items: queueContext.state?.total_items ?? result.queue_status.total_items ?? 0,
    };
  }
  return result;
}

export async function onRequestGet(context) {
  if (!context.env?.MINUTE_DB) {
    return new Response(JSON.stringify({ ok: false, error: 'MINUTE_DB binding missing' }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const url = new URL(context.request.url);
  const queueContext = {
    requestedRevision: url.searchParams.get('queue_revision') || '',
    revision: '',
    state: null,
    hostIdentity: '',
    unchanged: false,
    contextPromise: null,
  };
  const predictionPromise = loadPredictionState(context.env.MINUTE_DB).catch((error) => {
    console.error(error);
    return null;
  });
  const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
  const includeHistory = url.searchParams.get('history') !== '0';
  try {
    const [facts, predictionState] = await Promise.all([
      loadFactsDashboard(context.env.MINUTE_DB, { since, includeHistory }),
      predictionPromise,
    ]);
    if (!factsAreFresh(facts.latest)) {
      return new Response(JSON.stringify({ ok: false, error: 'MINUTE_DB telemetry is stale' }), {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    const models = await loadPublicReadModels(context.env.MINUTE_DB, facts.latest.channel_id);
    const presentation = presentationFromRow(models.presentation);
    const channel = presentation.channel || presentation;
    const station = channel.current_station || presentation.current_station || {};
    const owner = station.owner || presentation.owner || {};
    const streaming = station.streaming_party || presentation.streaming_party || {};
    const latest = { ...presentation, ...presentation.latest, ...facts.latest };
    const goal = latest.stream_goal ?? streaming.stream_goal ?? null;
    const { latestQueue, queue } = queueFromReadModel(models.queue);
    const generatedAt = Date.now();
    const playback = computePlayback(queue, generatedAt);
    const startIndex = Math.max(0, playback.currentIndex);
    const queueWindow = queue.slice(startIndex, startIndex + 11);
    const enrichedQueue = queueWindow.map((track, index) => normalizePlaybackTrack(track, startIndex + index, playback));
    queueContext.state = stateFromQueue(latestQueue, queue);
    queueContext.hostIdentity = hostIdentity(latest);
    queueContext.revision = queueRevision(queueContext.state, queueContext.hostIdentity);
    queueContext.unchanged = Boolean(queueContext.requestedRevision && queueContext.requestedRevision === queueContext.revision);

    const now = Date.now();
    const shifted = new Date(now + 9 * 3600000);
    const range = (hour) => {
      let currentStart = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), hour) - 9 * 3600000;
      if (now < currentStart) currentStart -= 86400000;
      return { previousStart: currentStart - 86400000, currentStart };
    };
    const memberRange = range(16);
    const listensRange = range(9);
    const [previousMembers, previousListens] = await Promise.all([
      loadFactsBaseline(context.env.MINUTE_DB, 'total_member_count', facts.latest.host_id, memberRange.previousStart, memberRange.currentStart),
      loadFactsBaseline(context.env.MINUTE_DB, 'total_listens', facts.latest.host_id, listensRange.previousStart, listensRange.currentStart),
    ]);
    const current = num(latest.current_stream_count ?? streaming.current_stream_count ?? latest.total_listens);
    const { goalPrediction, goalPredictions } = dashboardGoalPredictions({
      rows: facts.history,
      aggregate: facts.prediction,
      current,
      configuredGoal: num(goal),
      now: generatedAt,
      useAggregate: since > 0 || !includeHistory,
    });
    const payload = {
      ok: true,
      generated_at: generatedAt,
      metrics_source: 'facts-db',
      storage_source: 'facts-db',
      delta: since > 0,
      history_deferred: since <= 0 && !includeHistory,
      latest_observed_at: latest.observed_at || since,
      latest: publicLatest(latest, channel, station, owner, goal),
      history: facts.history,
      daily_change: {
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
      },
      goal_prediction: goalPrediction,
      goal_predictions: goalPredictions,
      queue: queueContext.unchanged ? [] : enrichedQueue,
      queue_status: compactQueueStatus(latestQueue, latest, playback, queue.length, queueWindow.length),
      ...queueResponseFields(queueContext),
    };
    const currentGoal = finite(payload.latest?.stream_goal);
    const selectedPrediction = selectGoalPrediction(
      predictionState,
      payload.goal_prediction,
      currentGoal,
    );
    payload.goal_prediction = selectedPrediction;
    payload.goal_predictions = mergeGoalPredictions(payload.goal_predictions, selectedPrediction, currentGoal);
    return new Response(JSON.stringify(decorateQueueResponse(payload, queueContext)), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ ok: false, error: error?.message || 'dashboard error' }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}
