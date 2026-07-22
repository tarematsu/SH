import { streamPredictionDue } from './runtime-scheduled.js';

const EMPTY_OPTIONS = Object.freeze({});
let predictionModulePromise;

function loadPredictionModule() {
  predictionModulePromise ||= import('./stream-goal-prediction.js');
  return predictionModulePromise;
}

export async function dispatchStreamPrediction(controller, env, _ctx, options = EMPTY_OPTIONS) {
  const scheduledAt = Number(controller?.scheduledTime) || Date.now();
  if (!streamPredictionDue(scheduledAt)) {
    return [{ skipped: true, reason: 'stream-prediction-not-due' }];
  }
  const run = options.dependencies?.prediction
    || (await loadPredictionModule()).runStreamGoalPrediction;
  const result = await run(env, scheduledAt);
  options.healthApp?.invalidateHealthCache?.();
  return [result];
}
