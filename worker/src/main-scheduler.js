import app from './email-recap-index.js';
import { runCloudHostMonitor } from './cloud-host-monitor.js';
import { runCloudWeeklyLeaderboard } from './cloud-weekly-leaderboard.js';

const DEFAULT_PRIMARY_WATCHDOG_MS = 55_000;
const MIN_PRIMARY_WATCHDOG_MS = 10_000;
const MAX_PRIMARY_WATCHDOG_MS = 55_000;

const DEFAULT_AUXILIARY_RUNNERS = Object.freeze({
  weekly: { failureEvent: 'cloud_weekly_leaderboard_failed', run: runCloudWeeklyLeaderboard },
  host: { failureEvent: 'cloud_host_monitor_failed', run: runCloudHostMonitor, onFailureOnly: true },
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

function normalizeAuxiliaryRunners(runners = DEFAULT_AUXILIARY_RUNNERS) {
  return Object.entries(runners).map(([name, runner]) => (
    typeof runner === 'function'
      ? { name, failureEvent: `${name}_failed`, run: runner, onFailureOnly: false }
      : { name, onFailureOnly: false, ...runner }
  ));
}

function reportAuxiliaryFailures(tasks, results) {
  for (const [index, result] of results.entries()) {
    if (result.status !== 'rejected') continue;
    console.error(JSON.stringify({
      event: tasks[index]?.failureEvent || 'scheduled_auxiliary_failed',
      error: String(result.reason?.message || result.reason),
    }));
  }
}

function startAuxiliaryOnce(flight, env, includeFailureOnly, runners) {
  const tasks = [];
  for (const runner of normalizeAuxiliaryRunners(runners)) {
    if (runner.onFailureOnly && !includeFailureOnly) continue;
    if (!flight[runner.name]) flight[runner.name] = Promise.resolve().then(() => runner.run(env));
    tasks.push({ failureEvent: runner.failureEvent, promise: flight[runner.name] });
  }
  flight.auxiliary = Promise.allSettled(tasks.map((task) => task.promise)).then((results) => {
    reportAuxiliaryFailures(tasks, results);
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
    resetCollector?.();
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
  const flight = ensurePrimaryScheduledFlight(controller, env, ctx, scheduled, runners);
  let timeoutId = null;

  try {
    return await Promise.race([
      flight.primary,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          abandonPrimaryFlight(flight, options.resetCollectionFlight);
          reject(new PrimaryCollectionTimeoutError(timeoutMs, controller?.cron));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
}
