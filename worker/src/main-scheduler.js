import { claimPrimaryRunLock, releasePrimaryRunLock } from './primary-run-lock.js';

const DEFAULT_PRIMARY_WATCHDOG_MS = 55_000;
const MIN_PRIMARY_WATCHDOG_MS = 10_000;
const MAX_PRIMARY_WATCHDOG_MS = 55_000;

export const COLLECTION_ABORT_SIGNAL = '__COLLECTION_ABORT_SIGNAL';
export const COLLECTION_DEADLINE_AT = '__COLLECTION_DEADLINE_AT';

const NO_AUXILIARY_RUNNERS = Object.freeze({});

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

export function withCollectionRuntime(env = {}, signal = null, deadlineAt = null) {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === COLLECTION_ABORT_SIGNAL) return signal;
      if (property === COLLECTION_DEADLINE_AT) return deadlineAt;
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      return property === COLLECTION_ABORT_SIGNAL
        || property === COLLECTION_DEADLINE_AT
        || Reflect.has(target, property);
    },
  });
}

function startAuxiliaryOnce(flight, env, includeFailureOnly, runners = NO_AUXILIARY_RUNNERS) {
  if (!runners || runners === NO_AUXILIARY_RUNNERS || Object.keys(runners).length === 0) {
    return Promise.resolve([]);
  }
  const tasks = Object.entries(runners).flatMap(([name, task]) => {
    const definition = typeof task === 'function' ? {} : (task || {});
    const runner = typeof task === 'function' ? task : task?.run;
    if (definition.onFailureOnly && !includeFailureOnly) return [];
    if (!flight[name]) flight[name] = Promise.resolve().then(() => runner(env));
    return [{ failureEvent: definition.failureEvent || 'scheduled_auxiliary_failed', promise: flight[name] }];
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

function runLockHolderId(now) {
  return `${now}-${crypto.randomUUID()}`;
}

// Only releases the lock when `scheduled` resolves normally. On abort/error
// the lease is left to expire on its own TTL, since Cloudflare aborting our
// await doesn't forcibly stop the underlying collection -- releasing early
// here would just let the very next cron tick race a run that may still be
// finishing up in the background.
async function runPrimaryWithLock(controller, env, runtimeEnv, ctx, scheduled) {
  const now = Date.now();
  const holderId = runLockHolderId(now);
  const claimed = await claimPrimaryRunLock(env, holderId, now);
  if (!claimed) {
    return { skipped: true, reason: 'primary-run-in-progress' };
  }
  const result = await scheduled(controller, runtimeEnv, ctx);
  await releasePrimaryRunLock(env, holderId).catch(() => {});
  return result;
}

function primaryFlightForRequest(controller, env, ctx, scheduled, timeoutMs) {
  const key = requestContextKey(ctx);
  if (key) {
    const existing = primaryFlightsByContext.get(key);
    if (existing) return existing;
  }

  const abortController = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  const runtimeEnv = withCollectionRuntime(env, abortController.signal, deadlineAt);
  const flight = {
    abortController,
    primary: env?.DB
      ? runPrimaryWithLock(controller, env, runtimeEnv, ctx, scheduled)
      : Promise.resolve().then(() => scheduled(controller, runtimeEnv, ctx)),
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
  scheduled,
  timeoutOverride = null,
  options = {},
) {
  const timeoutMs = timeoutOverride ?? primaryWatchdogMs(env);
  const flight = primaryFlightForRequest(controller, env, ctx, scheduled, timeoutMs);
  let timeoutId = null;

  try {
    const result = await Promise.race([
      flight.primary,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          releaseRequestFlight(ctx, flight);
          const timeoutError = new PrimaryCollectionTimeoutError(timeoutMs, controller?.cron);
          try {
            flight.abortController.abort(timeoutError);
          } catch (error) {
            console.error(JSON.stringify({
              event: 'collector_abort_failed',
              error: String(error?.message || error),
            }));
          }
          try {
            options.resetCollectionFlight?.();
          } catch (error) {
            console.error(JSON.stringify({
              event: 'collector_flight_reset_failed',
              error: String(error?.message || error),
            }));
          }
          reject(timeoutError);
        }, timeoutMs);
      }),
    ]);
    const auxiliary = startAuxiliaryOnce(
      flight,
      env,
      false,
      options.auxiliaryRunners || NO_AUXILIARY_RUNNERS,
    );
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(auxiliary);
    else await auxiliary;
    return result;
  } catch (error) {
    const auxiliary = startAuxiliaryOnce(
      flight,
      env,
      true,
      options.auxiliaryRunners || NO_AUXILIARY_RUNNERS,
    );
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(auxiliary);
    else await auxiliary;
    throw error;
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
}
