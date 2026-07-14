import { withDuplicateVelocityReadRemoved } from './d1-read-optimizer.js';
import { withD1WriteThrottling } from './main-d1-throttle.js';
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
  return runPrimary(
    controller,
    collectionEnv,
    ctx,
    options.scheduled || runOptimizedScheduled,
    options.timeoutOverride ?? null,
    {
      auxiliaryRunners: options.auxiliaryRunners || NO_AUXILIARY_RUNNERS,
      resetCollectionFlight: options.resetCollectionFlight,
    },
  );
}

export default {
  async scheduled(controller, env, ctx) {
    const optimizedEnv = withDuplicateVelocityReadRemoved(env);
    return runPrimaryCycle(controller, withD1WriteThrottling(optimizedEnv), env, ctx);
  },

  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
