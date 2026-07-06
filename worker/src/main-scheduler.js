import app from './email-recap-index.js';
import { runCloudHostMonitor } from './cloud-host-monitor.js';
import { runCloudWeeklyLeaderboard } from './cloud-weekly-leaderboard.js';

const DEFAULT_PRIMARY_WATCHDOG_MS = 55_000;
const MIN_PRIMARY_WATCHDOG_MS = 10_000;
const MAX_PRIMARY_WATCHDOG_MS = 55_000;

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
