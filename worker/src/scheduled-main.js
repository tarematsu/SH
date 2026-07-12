import mainApp, { withD1WriteThrottling } from './main.js';
import app from './email-recap-index.js';
import {
  PrimaryCollectionTimeoutError,
  resetPrimaryScheduledFlightForTests as resetSharedPrimaryScheduledFlightForTests,
  runPrimaryScheduled as runSharedPrimaryScheduled,
} from './main-scheduler.js';
import { expireLeaseWhenPrimaryFailed as defaultExpireLeaseWhenPrimaryFailed } from './main-lease.js';
import { runCloudHostMonitor } from './cloud-host-monitor.js';
import { runScheduledMaintenance } from './scheduled-maintenance.js';
import { runStreamGoalPrediction } from './stream-goal-prediction.js';

export { PrimaryCollectionTimeoutError };
export { defaultExpireLeaseWhenPrimaryFailed as expireLeaseWhenPrimaryFailed };
export {
  CLAIM_STREAM_GOAL_PREDICTION_SQL,
  STREAM_GOAL_PREDICTION_AGGREGATE_SQL,
  predictionFromAggregate,
  runStreamGoalPrediction,
  streamGoalPredictionIntervalMs,
} from './stream-goal-prediction.js';

const SCHEDULED_AUXILIARY_RUNNERS = Object.freeze({
  prediction: { failureEvent: 'stream_goal_prediction_failed', run: runStreamGoalPrediction },
  maintenance: { failureEvent: 'data_maintenance_failed', run: runScheduledMaintenance },
  host: { failureEvent: 'cloud_host_monitor_failed', run: runCloudHostMonitor, onFailureOnly: true },
});
const NO_AUXILIARY_RUNNERS = Object.freeze({});

// Set on env by production-entry.js's withBuddyPlaybackDeferred proxy so the
// buddies worker never duplicates the stream goal prediction, scheduled
// maintenance, and cloud host monitor work that the dedicated "other" worker
// already runs on its own cron.
export const DEFER_AUXILIARY_RUNNERS_FLAG = '__DEFER_AUXILIARY_RUNNERS';

export function shouldDeferAuxiliaryRunners(env = {}) {
  return Boolean(env?.[DEFER_AUXILIARY_RUNNERS_FLAG]);
}

export function resetPrimaryScheduledFlightForTests() {
  resetSharedPrimaryScheduledFlightForTests();
}

export function runPrimaryScheduled(
  controller,
  env,
  ctx,
  scheduled = app.scheduled.bind(app),
  timeoutOverride = null,
  options = {},
) {
  const auxiliaryRunners = options.auxiliaryRunners
    || (shouldDeferAuxiliaryRunners(env) ? NO_AUXILIARY_RUNNERS : SCHEDULED_AUXILIARY_RUNNERS);
  return runSharedPrimaryScheduled(controller, env, ctx, scheduled, timeoutOverride, {
    ...options,
    auxiliaryRunners,
  });
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
  const expireLease = options.expireLease || defaultExpireLeaseWhenPrimaryFailed;
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
