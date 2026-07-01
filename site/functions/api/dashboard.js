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

const cache = { value: null, expiresAt: 0, pending: null };

export async function cachedPrediction(statement, now = Date.now()) {
  if (cache.value && cache.expiresAt > now) return cache.value;
  if (!cache.pending) {
    cache.pending = Promise.resolve(statement.first()).then((value) => {
      cache.value = value;
      cache.expiresAt = Date.now() + 60000;
      return value;
    }).finally(() => { cache.pending = null; });
  }
  return cache.pending;
}

export function resetPredictionCache() {
  cache.value = null;
  cache.expiresAt = 0;
  cache.pending = null;
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
  SELECT station_id,queue_id,start_time,is_paused,observed_at
  FROM sh_queue_snapshots
  WHERE station_id=(SELECT station_id FROM latest_channel)
  ORDER BY observed_at DESC,id DESC
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
      if (sql === PREDICTION_24H_SQL && property === 'first') return () => cachedPrediction(target);
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
  const response = await legacyDashboard({
    ...context,
    env: { ...context.env, DB: proxyDatabase(context.env.DB, queueContext) },
  });
  if (!response.ok) return response;
  const body = await response.text();
  const output = queueContext.unchanged
    ? JSON.stringify(decorateQueueResponse(JSON.parse(body), queueContext))
    : appendJsonObjectFields(body, queueResponseFields(queueContext));
  return new Response(output, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
