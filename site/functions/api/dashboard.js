import {
  onRequestGet as legacyDashboard,
  hostScopeFromSnapshot,
  linearRegressionPrediction,
  linearRegressionPredictionFromAggregate,
  cachedHostMetric,
  resetHostMetricCache,
  HISTORY_24H_SQL,
  PREDICTION_24H_SQL,
} from './dashboard-legacy.mjs';
import { LATEST_QUEUE_WITH_ITEMS_SQL, parseLatestQueueRows } from '../lib/latest-queue.js';
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

const cache = { value: null, hasValue: false, expiresAt: 0, pending: null };

export async function cachedPrediction(statement, now = Date.now()) {
  if (cache.hasValue && cache.expiresAt > now) return cache.value;
  if (!cache.pending) {
    cache.pending = Promise.resolve(statement.first()).then((value) => {
      cache.value = value ?? null;
      cache.hasValue = true;
      cache.expiresAt = Date.now() + 60000;
      return cache.value;
    }).finally(() => { cache.pending = null; });
  }
  return cache.pending;
}

export function resetPredictionCache() {
  cache.value = null;
  cache.hasValue = false;
  cache.expiresAt = 0;
  cache.pending = null;
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

async function loadPredictionState(db) {
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
    host_account_id,host_handle,broadcast_start_time,comment_velocity,raw_json
  FROM sh_channel_snapshots
  ORDER BY observed_at DESC,id DESC
  LIMIT 1
), latest_queue AS (
  SELECT station_id,queue_id,start_time,is_paused,observed_at,
    structural_hash,likes_hash
  FROM sh_queue_current
  WHERE station_id=(SELECT station_id FROM latest_channel)
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
  return value.includes('comment_velocity,raw_json')
    && value.includes('FROM sh_channel_snapshots ORDER BY observed_at DESC,id DESC LIMIT 1');
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
      if (sql === PREDICTION_24H_SQL && property === 'first') {
        return async () => null;
      }
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
  if (!context.env?.DB) return legacyDashboard(context);
  const url = new URL(context.request.url);
  const queueContext = {
    requestedRevision: url.searchParams.get('queue_revision') || '',
    revision: '',
    state: null,
    hostIdentity: '',
    unchanged: false,
    contextPromise: null,
  };
  const predictionPromise = loadPredictionState(context.env.DB).catch((error) => {
    console.error(error);
    return null;
  });
  const response = await legacyDashboard({
    ...context,
    env: { ...context.env, DB: proxyDatabase(context.env.DB, queueContext) },
  });
  if (!response.ok) return response;

  const [body, predictionState] = await Promise.all([
    response.text(),
    predictionPromise,
  ]);
  const payload = JSON.parse(body);
  payload.goal_prediction = selectGoalPrediction(
    predictionState,
    payload.goal_prediction,
    finite(payload.latest?.stream_goal),
  );
  const output = JSON.stringify(decorateQueueResponse(payload, queueContext));
  return new Response(output, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
