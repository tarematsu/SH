import mainApp, { withD1WriteThrottling } from './main.js';
import app from './email-recap-index.js';
import { runCloudHostMonitor } from './cloud-host-monitor.js';
import { runCloudWeeklyLeaderboard } from './cloud-weekly-leaderboard.js';
import { resetCollectionFlight } from './index.js';

const PRIMARY_LEASE_SCOPE = 'stationhead-primary';
const PRIMARY_SUCCESS_GRACE_MS = 5_000;
const DEFAULT_PRIMARY_WATCHDOG_MS = 55_000;
const MIN_PRIMARY_WATCHDOG_MS = 10_000;
const MAX_PRIMARY_WATCHDOG_MS = 55_000;
const DEFAULT_AUXILIARY_RUNNERS = Object.freeze({
  weekly: runCloudWeeklyLeaderboard,
  host: runCloudHostMonitor,
});

let primaryScheduledFlight = null;

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

function startAuxiliaryOnce(flight, env, includeHost, runners) {
  if (!flight.weekly) flight.weekly = Promise.resolve().then(() => runners.weekly(env));
  if (includeHost && !flight.host) {
    flight.host = Promise.resolve().then(() => runners.host(env));
  }
  const tasks = [flight.weekly, ...(flight.host ? [flight.host] : [])];
  flight.auxiliary = Promise.allSettled(tasks).then((results) => {
    reportAuxiliaryFailures(results);
    return results;
  });
  return flight.auxiliary;
}

function releasePrimaryFlight(flight) {
  if (primaryScheduledFlight === flight) primaryScheduledFlight = null;
}

function ensurePrimaryScheduledFlight(controller, env, ctx, scheduled, runners) {
  if (primaryScheduledFlight) return primaryScheduledFlight;

  let signalTimeout;
  const timeoutOutcome = new Promise((resolve) => {
    signalTimeout = () => resolve({ failed: true });
  });
  const flight = {
    primary: Promise.resolve().then(() => scheduled(controller, env, ctx)),
    weekly: null,
    host: null,
    auxiliary: null,
    lifecycle: null,
    signalTimeout,
  };
  primaryScheduledFlight = flight;

  const primaryOutcome = flight.primary.then(
    () => {
      releasePrimaryFlight(flight);
      return { failed: false };
    },
    () => {
      releasePrimaryFlight(flight);
      return { failed: true };
    },
  );
  flight.lifecycle = Promise.race([primaryOutcome, timeoutOutcome])
    .then(({ failed }) => startAuxiliaryOnce(flight, env, failed, runners));
  ctx?.waitUntil?.(flight.lifecycle);
  return flight;
}

function abandonPrimaryFlight(flight, resetCollector) {
  releasePrimaryFlight(flight);
  try {
    resetCollector();
  } catch (error) {
    console.error(JSON.stringify({
      event: 'collector_flight_reset_failed',
      error: String(error?.message || error),
    }));
  }
  flight.signalTimeout?.();
}

export function resetPrimaryScheduledFlightForTests() {
  primaryScheduledFlight = null;
  resetCollectionFlight();
}

export async function runPrimaryScheduled(
  controller,
  env,
  ctx,
  scheduled = app.scheduled.bind(app),
  timeoutOverride = null,
  options = {},
) {
  const timeoutMs = timeoutOverride ?? primaryWatchdogMs(env);
  const runners = options.auxiliaryRunners || DEFAULT_AUXILIARY_RUNNERS;
  const resetCollector = options.resetCollectionFlight || resetCollectionFlight;
  const flight = ensurePrimaryScheduledFlight(controller, env, ctx, scheduled, runners);
  let timeoutId = null;

  try {
    return await Promise.race([
      flight.primary,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          abandonPrimaryFlight(flight, resetCollector);
          reject(new PrimaryCollectionTimeoutError(timeoutMs, controller?.cron));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
}

export async function expireLeaseWhenPrimaryFailed(env, runStartedAt) {
  if (!env?.DB) return;
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
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || ''))) throw error;
  }
}

export async function runPrimaryCycle(
  controller,
  collectionEnv,
  leaseEnv,
  ctx,
  options = {},
) {
  const runStartedAt = options.runStartedAt ?? Date.now();
  const runPrimary = options.runPrimary || runPrimaryScheduled;
  const expireLease = options.expireLease || expireLeaseWhenPrimaryFailed;
  try {
    return await runPrimary(
      controller,
      collectionEnv,
      ctx,
      options.scheduled || app.scheduled.bind(app),
      options.timeoutOverride ?? null,
      {
        auxiliaryRunners: options.auxiliaryRunners,
        resetCollectionFlight: options.resetCollectionFlight,
      },
    );
  } catch (primaryError) {
    try {
      await expireLease(leaseEnv, runStartedAt);
    } catch (leaseError) {
      console.error(JSON.stringify({
        event: 'collector_lease_expiry_failed',
        error: String(leaseError?.message || leaseError),
      }));
    }
    throw primaryError;
  }
}

export default {
  async scheduled(controller, env, ctx) {
    return runPrimaryCycle(controller, withD1WriteThrottling(env), env, ctx);
  },

  fetch(request, env, ctx) {
    return mainApp.fetch(request, env, ctx);
  },
};
