import mainApp, { withD1WriteThrottling } from './main.js';
import app from './official-news-reconcile-entry.js';
import {
  PrimaryCollectionTimeoutError,
  resetPrimaryScheduledFlightForTests as resetSharedPrimaryScheduledFlightForTests,
  runPrimaryScheduled as runSharedPrimaryScheduled,
} from './main-scheduler.js';
import { expireLeaseWhenPrimaryFailed as defaultExpireLeaseWhenPrimaryFailed } from './main-lease.js';
import { runCloudHostMonitor } from './cloud-host-monitor.js';
import { runCloudWeeklyLeaderboard } from './cloud-weekly-leaderboard.js';
import { resetCollectionFlight } from './index.js';
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
  weekly: { failureEvent: 'cloud_weekly_leaderboard_failed', run: runCloudWeeklyLeaderboard },
  prediction: { failureEvent: 'stream_goal_prediction_failed', run: runStreamGoalPrediction },
  maintenance: { failureEvent: 'data_maintenance_failed', run: runScheduledMaintenance },
  host: { failureEvent: 'cloud_host_monitor_failed', run: runCloudHostMonitor, onFailureOnly: true },
});

export function resetPrimaryScheduledFlightForTests() {
  resetSharedPrimaryScheduledFlightForTests();
  resetCollectionFlight();
}

export function runPrimaryScheduled(
  controller,
  env,
  ctx,
  scheduled = app.scheduled.bind(app),
  timeoutOverride = null,
  options = {},
) {
  return runSharedPrimaryScheduled(controller, env, ctx, scheduled, timeoutOverride, {
    ...options,
    auxiliaryRunners: options.auxiliaryRunners || SCHEDULED_AUXILIARY_RUNNERS,
    resetCollectionFlight: options.resetCollectionFlight || resetCollectionFlight,
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
