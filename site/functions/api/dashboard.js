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
  const revision = queueContext.revision
    || queueRevision(queueContext.state, queueContext.hostIdentity);
  return {
    queue_revision: revision,
    queue_unchanged: Boolean(queueContext.unchanged),
  };
}

export function appendJsonObjectFields(body, fields) {
  const text = String(body || '');
  const trimmed = text.trim();
  const encoded = JSON.stringify(fields || {}).slice(1, -1);
  if (!encoded || !trimmed.startsWith('{') || !trimmed.endsWith('}')) return text;
  const closing = text.lastIndexOf('}');
  const hasProperties = trimmed !== '{}';
  return `${text.slice(0, closing)}${hasProperties ? ',' : ''}${encoded}${text.slice(closing)}`;
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
  if (!response.ok) return response;
  const body = await response.text();
  return new Response(appendJsonObjectFields(body, queueResponseFields(queueContext)), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
