import app from './email-recap-index.js';
import { runCloudHostMonitor } from './cloud-host-monitor.js';
import { runCloudWeeklyLeaderboard } from './cloud-weekly-leaderboard.js';
import { runScheduledMaintenance } from './scheduled-maintenance.js';

const DEFAULT_PRIMARY_WATCHDOG_MS = 55_000;
const MIN_PRIMARY_WATCHDOG_MS = 10_000;
const MAX_PRIMARY_WATCHDOG_MS = 55_000;

const DEFAULT_AUXILIARY_RUNNERS = Object.freeze({
  weekly: { failureEvent: 'cloud_weekly_leaderboard_failed', run: runCloudWeeklyLeaderboard },
  maintenance: { failureEvent: 'data_maintenance_failed', run: runScheduledMaintenance },
  host: { failureEvent: 'cloud_host_monitor_failed', run: runCloudHostMonitor, onFailureOnly: true },
});

let primaryFlightsByContext = new WeakMap();

function primaryWatchdogMs(env = {}) {
  const configured = Number(env.PRIMARY_COLLECTION_WATCHDOG_MS ?? DEFAULT_PRIMARY_WATCHDOG_MS);
  return Number.isFinite(configured)
    ? Math.max(MIN_PRIMARY_WATCHDOG_MS, Math.min(MAX_PRIMARY_WATCHDOG_MS, configured))
    : DEFAULT_PRIMARY_WATCHDOG_MS;
}

export class PrimaryCollectionTimeoutError extends Error {
  constructor(timeoutMs, cron) {
    super(`Primary Stationhead collection timed out after ${timeoutMs}ms (${cron || 'scheduled'})`);
    this.name = 'PrimaryCollectionTimeoutError';
    this.code = 'PRIMARY_COLLECTION_TIMEOUT';
    this.timeoutMs = timeoutMs;
  }
}

function startAuxiliaryOnce(flight, env, includeFailureOnly, runners = DEFAULT_AUXILIARY_RUNNERS) {
  const tasks = Object.entries(runners).flatMap(([name, task]) => {
    if (task.onFailureOnly && !includeFailureOnly) return [];
    if (!flight[name]) flight[name] = Promise.resolve().then(() => task.run(env));
    return [{ failureEvent: task.failureEvent || 'scheduled_auxiliary_failed', promise: flight[name] }];
  });
  return Promise.allSettled(tasks.map((task) => task.promise)).then((results) => {
    for (const [index, result] of results.entries()) {
      if (result.status !== 'rejected') continue;
      console.error(JSON.stringify({
        event: tasks[index]?.failureEvent || 'scheduled_auxiliary_failed',
        error: String(result.reason?.message || result.reason),
      }));
    }
    return results;
  });
}

function requestContextKey(ctx) {
  return ctx && (typeof ctx === 'object' || typeof ctx === 'function') ? ctx : null;
}

function releaseRequestFlight(ctx, flight) {
  const key = requestContextKey(ctx);
  if (key && primaryFlightsByContext.get(key) === flight) primaryFlightsByContext.delete(key);
}

function primaryFlightForRequest(controller, env, ctx, scheduled) {
  const key = requestContextKey(ctx);
  if (key) {
    const existing = primaryFlightsByContext.get(key);
    if (existing) return existing;
  }

  const flight = {
    primary: Promise.resolve().then(() => scheduled(controller, env, ctx)),
  };
  if (key) primaryFlightsByContext.set(key, flight);
  flight.primary.then(
    () => releaseRequestFlight(ctx, flight),
    () => releaseRequestFlight(ctx, flight),
  );
  return flight;
}

export function resetPrimaryScheduledFlightForTests() {
  primaryFlightsByContext = new WeakMap();
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
  const flight = primaryFlightForRequest(controller, env, ctx, scheduled);
  let timeoutId = null;

  try {
    const result = await Promise.race([
      flight.primary,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          releaseRequestFlight(ctx, flight);
          try {
            options.resetCollectionFlight?.();
          } catch (error) {
            console.error(JSON.stringify({
              event: 'collector_flight_reset_failed',
              error: String(error?.message || error),
            }));
          }
          reject(new PrimaryCollectionTimeoutError(timeoutMs, controller?.cron));
        }, timeoutMs);
      }),
    ]);
    const auxiliary = startAuxiliaryOnce(
      flight,
      env,
      false,
      options.auxiliaryRunners || DEFAULT_AUXILIARY_RUNNERS,
    );
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(auxiliary);
    else await auxiliary;
    return result;
  } catch (error) {
    const auxiliary = startAuxiliaryOnce(
      flight,
      env,
      true,
      options.auxiliaryRunners || DEFAULT_AUXILIARY_RUNNERS,
    );
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(auxiliary);
    else await auxiliary;
    throw error;
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
}
