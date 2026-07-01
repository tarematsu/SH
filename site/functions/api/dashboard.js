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
  DASHBOARD_QUEUE_STATE_SQL,
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
const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const predictionSql = normalize(PREDICTION_24H_SQL);
const queueSql = normalize(LATEST_QUEUE_WITH_ITEMS_SQL);

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

async function loadDashboardQueue(statement, db, queueContext) {
  if (!queueContext.requestedRevision) {
    const result = await statement.all();
    const parsed = parseLatestQueueRows(result.results || []);
    queueContext.state = stateFromQueue(parsed.latestQueue, parsed.queue);
    return result;
  }

  const stateRow = await db.prepare(DASHBOARD_QUEUE_STATE_SQL).first();
  queueContext.state = parseQueueState(stateRow);
  queueContext.hostIdentity = hostIdentity(stateRow);
  queueContext.revision = queueRevision(queueContext.state, queueContext.hostIdentity);
  if (queueContext.revision === queueContext.requestedRevision) {
    queueContext.unchanged = true;
    return queueHeaderResult(queueContext.state);
  }
  return statement.all();
}

function proxyStatement(statement, sql, db, queueContext) {
  const normalized = normalize(sql);
  return new Proxy(statement, {
    get(target, property) {
      if (normalized === predictionSql && property === 'first') return () => cachedPrediction(target);
      if (normalized === queueSql && property === 'all') {
        return () => loadDashboardQueue(target, db, queueContext);
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

export function decorateQueueResponse(payload, queueContext) {
  if (!payload?.ok) return payload;
  const identity = queueContext.hostIdentity || hostIdentity(payload.latest);
  const revision = queueContext.revision || queueRevision(queueContext.state, identity);
  const result = {
    ...payload,
    queue_revision: revision,
    queue_unchanged: Boolean(queueContext.unchanged),
  };
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
  };
  const response = await legacyDashboard({
    ...context,
    env: { ...context.env, DB: proxyDatabase(context.env.DB, queueContext) },
  });
  const payload = await response.clone().json().catch(() => null);
  if (!payload) return response;
  return new Response(JSON.stringify(decorateQueueResponse(payload, queueContext)), {
    status: response.status,
    headers: response.headers,
  });
}
