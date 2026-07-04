import app from './email-recap-index.js';
import { runCloudHostMonitor } from './cloud-host-monitor.js';
import { runCloudWeeklyLeaderboard } from './cloud-weekly-leaderboard.js';

const PRIMARY_LEASE_SCOPE = 'stationhead-primary';
const PRIMARY_SUCCESS_GRACE_MS = 5000;
const DEFAULT_PRIMARY_WATCHDOG_MS = 55_000;
const MIN_PRIMARY_WATCHDOG_MS = 10_000;
const MAX_PRIMARY_WATCHDOG_MS = 55_000;

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
    let appError;
    try {
      await runPrimaryScheduled(controller, env, ctx);
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
