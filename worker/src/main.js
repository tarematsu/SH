import app from './email-recap-index.js';
import { runCloudHostMonitor } from './cloud-host-monitor.js';
import { runCloudWeeklyLeaderboard } from './cloud-weekly-leaderboard.js';

const PRIMARY_LEASE_SCOPE = 'stationhead-primary';
const PRIMARY_SUCCESS_GRACE_MS = 5000;
const DEFAULT_PRIMARY_WATCHDOG_MS = 55_000;
const MIN_PRIMARY_WATCHDOG_MS = 10_000;
const MAX_PRIMARY_WATCHDOG_MS = 55_000;
const ORIGINAL_D1_STATEMENT = Symbol('original-d1-statement');

let primaryScheduledFlight = null;

function normalizeHealthPayload(payload) {
  if (payload?.cloud_solo_phase === 'idle') {
    if (payload.cloud_solo_session_id === 0) payload.cloud_solo_session_id = null;
    if (payload.cloud_solo_station_id === 0) payload.cloud_solo_station_id = null;
  }
  return payload;
}

function primaryWatchdogMs(env = {}) {
  const configured = Number(env.PRIMARY_COLLECTION_WATCHDOG_MS ?? DEFAULT_PRIMARY_WATCHDOG_MS);
  if (!Number.isFinite(configured)) return DEFAULT_PRIMARY_WATCHDOG_MS;
  return Math.max(MIN_PRIMARY_WATCHDOG_MS, Math.min(MAX_PRIMARY_WATCHDOG_MS, configured));
}

export function rewriteThrottledSql(value) {
  let sql = String(value || '');

  if (sql.includes('INSERT INTO sh_collector_leases') && !sql.includes('sh_collector_leases.updated_at >= 120000')) {
    sql = sql.replace(
      'metadata_json=excluded.metadata_json',
      `metadata_json=excluded.metadata_json
      WHERE excluded.updated_at-sh_collector_leases.updated_at >= 120000
         OR excluded.holder_id IS NOT sh_collector_leases.holder_id
         OR excluded.holder_kind IS NOT sh_collector_leases.holder_kind
         OR excluded.priority IS NOT sh_collector_leases.priority
         OR excluded.metadata_json IS NOT sh_collector_leases.metadata_json`,
    );
  }

  if (sql.includes('INSERT INTO sh_collector_heartbeats') && !sql.includes('sh_collector_heartbeats.last_seen_at>=300000')) {
    sql = sql.replace(
      'version=excluded.version, metadata_json=excluded.metadata_json',
      `version=excluded.version, metadata_json=excluded.metadata_json
      WHERE excluded.last_seen_at-sh_collector_heartbeats.last_seen_at>=300000
         OR excluded.hostname IS NOT sh_collector_heartbeats.hostname
         OR excluded.version IS NOT sh_collector_heartbeats.version
         OR excluded.metadata_json IS NOT sh_collector_heartbeats.metadata_json`,
    );
  }

  if (sql.includes('INSERT INTO sh_worker_collector_state') && !sql.includes('sh_worker_collector_state.last_success_at')) {
    sql = sql.replace(
      'updated_at=excluded.updated_at',
      `updated_at=excluded.updated_at
      WHERE excluded.auth_token IS NOT sh_worker_collector_state.auth_token
         OR excluded.device_uid IS NOT sh_worker_collector_state.device_uid
         OR excluded.token_expires_at IS NOT sh_worker_collector_state.token_expires_at
         OR excluded.last_error IS NOT sh_worker_collector_state.last_error
         OR excluded.last_channel_id IS NOT sh_worker_collector_state.last_channel_id
         OR excluded.last_station_id IS NOT sh_worker_collector_state.last_station_id
         OR COALESCE(excluded.last_success_at,0)-COALESCE(sh_worker_collector_state.last_success_at,0)>=300000
         OR COALESCE(excluded.last_run_at,0)-COALESCE(sh_worker_collector_state.last_run_at,0)>=300000`,
    );
  }

  if (sql.includes('INSERT INTO sh_cloud_host_monitor_state') && !sql.includes('sh_cloud_host_monitor_state.updated_at>=300000')) {
    sql = sql.replace(
      'last_error=excluded.last_error,updated_at=excluded.updated_at',
      `last_error=excluded.last_error,updated_at=excluded.updated_at
      WHERE excluded.phase IS NOT sh_cloud_host_monitor_state.phase
         OR excluded.session_id IS NOT sh_cloud_host_monitor_state.session_id
         OR excluded.station_id IS NOT sh_cloud_host_monitor_state.station_id
         OR excluded.candidate_count IS NOT sh_cloud_host_monitor_state.candidate_count
         OR excluded.inactive_count IS NOT sh_cloud_host_monitor_state.inactive_count
         OR excluded.last_profile_at IS NOT sh_cloud_host_monitor_state.last_profile_at
         OR excluded.last_queue_hash IS NOT sh_cloud_host_monitor_state.last_queue_hash
         OR excluded.last_error IS NOT sh_cloud_host_monitor_state.last_error
         OR excluded.updated_at-sh_cloud_host_monitor_state.updated_at>=300000`,
    );
  }

  return sql;
}

function wrapStatement(statement) {
  return new Proxy(statement, {
    get(target, property) {
      if (property === ORIGINAL_D1_STATEMENT) return target;
      if (property === 'bind') return (...args) => wrapStatement(target.bind(...args));
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function withD1WriteThrottling(env) {
  if (!env?.DB) return env;
  const db = env.DB;
  const wrappedDb = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => wrapStatement(target.prepare(rewriteThrottledSql(sql)));
      }
      if (property === 'batch') {
        return (statements) => target.batch(
          (statements || []).map((statement) => statement?.[ORIGINAL_D1_STATEMENT] || statement),
        );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === 'DB') return wrappedDb;
      return Reflect.get(target, property, receiver);
    },
  });
}

export class PrimaryCollectionTimeoutError extends Error {
  constructor(timeoutMs, cron) {
    super(`Primary Stationhead collection timed out after ${timeoutMs}ms (${cron || 'scheduled'})`);
    this.name = 'PrimaryCollectionTimeoutError';
    this.code = 'PRIMARY_COLLECTION_TIMEOUT';
    this.timeoutMs = timeoutMs;
  }
}

function reportAuxiliaryFailures(results) {
  for (const [index, result] of results.entries()) {
    if (result.status !== 'rejected') continue;
    console.error(JSON.stringify({
      event: index === 0 ? 'cloud_weekly_leaderboard_failed' : 'cloud_host_monitor_failed',
      error: String(result.reason?.message || result.reason),
    }));
  }
}

function startAuxiliaryOnce(flight, env, includeHost) {
  if (!flight.weekly) {
    flight.weekly = Promise.resolve().then(() => runCloudWeeklyLeaderboard(env));
  }
  if (includeHost && !flight.host) {
    flight.host = Promise.resolve().then(() => runCloudHostMonitor(env));
  }
  const tasks = [flight.weekly, ...(flight.host ? [flight.host] : [])];
  flight.auxiliary = Promise.allSettled(tasks).then((results) => {
    reportAuxiliaryFailures(results);
    return results;
  });
  return flight.auxiliary;
}

function ensurePrimaryScheduledFlight(controller, env, ctx, scheduled) {
  if (primaryScheduledFlight) return primaryScheduledFlight;

  const flight = {
    primary: Promise.resolve().then(() => scheduled(controller, env, ctx)),
    weekly: null,
    host: null,
    auxiliary: null,
    lifecycle: null,
  };
  primaryScheduledFlight = flight;

  flight.lifecycle = flight.primary.then(
    () => startAuxiliaryOnce(flight, env, false),
    () => startAuxiliaryOnce(flight, env, true),
  ).finally(() => {
    if (primaryScheduledFlight === flight) primaryScheduledFlight = null;
  });
  ctx?.waitUntil?.(flight.lifecycle);
  return flight;
}

export function resetPrimaryScheduledFlightForTests() {
  primaryScheduledFlight = null;
}

export async function runPrimaryScheduled(controller, env, ctx, scheduled = app.scheduled.bind(app), timeoutOverride = null) {
  const timeoutMs = timeoutOverride ?? primaryWatchdogMs(env);
  const flight = ensurePrimaryScheduledFlight(controller, env, ctx, scheduled);
  let timeoutId = null;

  try {
    return await Promise.race([
      flight.primary,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          startAuxiliaryOnce(flight, env, true);
          reject(new PrimaryCollectionTimeoutError(timeoutMs, controller?.cron));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
}

async function expireLeaseWhenPrimaryFailed(env, runStartedAt) {
  if (!env.DB) return;
  try {
    const state = await env.DB.prepare(`SELECT last_success_at,last_error
      FROM sh_worker_collector_state WHERE id='stationhead'`).first();
    const lastSuccessAt = Number(state?.last_success_at || 0);
    if (lastSuccessAt >= runStartedAt - PRIMARY_SUCCESS_GRACE_MS) return;

    await env.DB.prepare(`UPDATE sh_collector_leases
      SET lease_until=?,updated_at=?,metadata_json=?
      WHERE scope=? AND holder_kind='cloud'`)
      .bind(
        runStartedAt - 1,
        Date.now(),
        JSON.stringify({
          cron: 'every-minute',
          healthy: false,
          reason: 'primary_collection_failed',
          last_success_at: lastSuccessAt || null,
          last_error: state?.last_error || null,
        }),
        PRIMARY_LEASE_SCOPE,
      ).run();

    console.error(JSON.stringify({
      event: 'collector_lease_expired',
      reason: 'primary_collection_failed',
      last_success_at: lastSuccessAt || null,
      last_error: state?.last_error || null,
    }));
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || ''))) throw error;
  }
}

export default {
  async scheduled(controller, env, ctx) {
    const runStartedAt = Date.now();
    const scheduledEnv = withD1WriteThrottling(env);
    let appError;
    try {
      await runPrimaryScheduled(controller, scheduledEnv, ctx);
    } catch (error) {
      appError = error;
    }

    let leaseError;
    try {
      await expireLeaseWhenPrimaryFailed(env, runStartedAt);
    } catch (error) {
      leaseError = error;
    }

    if (appError) {
      if (leaseError) {
        console.error(JSON.stringify({
          event: 'collector_lease_expiry_failed',
          error: String(leaseError?.message || leaseError),
        }));
      }
      throw appError;
    }
    if (leaseError) throw leaseError;
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const response = await app.fetch(request, env, ctx);
    if (request.method !== 'GET' || (url.pathname !== '/' && url.pathname !== '/health')) {
      return response;
    }

    const payload = await response.json().catch(() => null);
    if (!payload) return response;
    return new Response(JSON.stringify(normalizeHealthPayload(payload)), {
      status: response.status,
      headers: response.headers,
    });
  },
};
