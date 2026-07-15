import { runOptimizedScheduled } from './optimized-index.js';
import {
  PrimaryCollectionTimeoutError,
  resetPrimaryScheduledFlightForTests as resetSharedPrimaryScheduledFlightForTests,
  runPrimaryScheduled as runSharedPrimaryScheduled,
} from './main-scheduler.js';

export { PrimaryCollectionTimeoutError };
const NO_AUXILIARY_RUNNERS = Object.freeze({});

export function resetPrimaryScheduledFlightForTests() {
  resetSharedPrimaryScheduledFlightForTests();
}

export function runPrimaryScheduled(
  controller,
  env,
  ctx,
  scheduled = runOptimizedScheduled,
  timeoutOverride = null,
  options = {},
) {
  return runSharedPrimaryScheduled(controller, env, ctx, scheduled, timeoutOverride, {
    ...options,
    auxiliaryRunners: options.auxiliaryRunners || NO_AUXILIARY_RUNNERS,
  });
}

function withFetchAbortSignal(env, runtimeEnv) {
  const signal = runtimeEnv?.__COLLECTION_ABORT_SIGNAL || null;
  if (!signal) return env;
  const active = Object.create(env || null);
  Object.defineProperty(active, '__COLLECTION_FETCH_ABORT_SIGNAL', {
    value: signal,
    enumerable: false,
  });
  return active;
}

export async function runPrimaryCycle(
  controller,
  collectionEnv,
  _leaseEnv,
  ctx,
  options = {},
) {
  const runPrimary = options.runPrimary || runPrimaryScheduled;
  const scheduled = options.scheduled || runOptimizedScheduled;
  // Preserve the watchdog signal for Stationhead HTTP, but keep it out of the
  // collector's D1 wrapper path. An in-flight D1 operation may finish after a
  // timeout; the primary lease and idempotent writes prevent overlap/data loss.
  const rawD1Scheduled = (activeController, runtimeEnv, activeCtx) => scheduled(
    activeController,
    withFetchAbortSignal(collectionEnv, runtimeEnv),
    activeCtx,
  );
  return runPrimary(
    controller,
    collectionEnv,
    ctx,
    rawD1Scheduled,
    options.timeoutOverride ?? null,
    {
      auxiliaryRunners: options.auxiliaryRunners || NO_AUXILIARY_RUNNERS,
      resetCollectionFlight: options.resetCollectionFlight,
    },
  );
}

export default {
  async scheduled(controller, env, ctx) {
    // D1 reads/writes are intentionally allowed to repeat. Avoiding the generic
    // statement-rewrite/cache Proxy removes traps, SQL classification and JSON
    // signatures from every collector D1 call.
    return runPrimaryCycle(controller, env, env, ctx);
  },

  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
