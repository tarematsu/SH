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

export async function runPrimaryCycle(
  controller,
  collectionEnv,
  _leaseEnv,
  ctx,
  options = {},
) {
  const runPrimary = options.runPrimary || runPrimaryScheduled;
  const scheduled = options.scheduled || runOptimizedScheduled;
  // The watchdog still limits the awaited cron and retains the D1 lease on
  // timeout, but the collector receives the raw environment. This avoids a
  // Proxy around every D1 prepare/bind/run. An in-flight D1 call may finish
  // after timeout, which is safe because all persistence paths are idempotent.
  const stageBoundaryScheduled = (activeController, _runtimeEnv, activeCtx) => (
    scheduled(activeController, collectionEnv, activeCtx)
  );
  return runPrimary(
    controller,
    collectionEnv,
    ctx,
    stageBoundaryScheduled,
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
