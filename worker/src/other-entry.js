import { scheduleBuddyPlayback, scheduledTimestamp } from './cadenced-entry.js';
import { runCloudHostMonitor } from './cloud-host-monitor.js';
import { runCloudWeeklyLeaderboard } from './cloud-weekly-leaderboard.js';
import { runScheduledMaintenance } from './scheduled-maintenance.js';
import { runStreamGoalPrediction } from './stream-goal-prediction.js';

export async function runOtherScheduled(controller, env, ctx, dependencies = {}) {
  const now = scheduledTimestamp(controller);
  const tasks = [
    (dependencies.buddy || scheduleBuddyPlayback)(env, ctx, now),
    (dependencies.host || runCloudHostMonitor)(env),
    (dependencies.weekly || runCloudWeeklyLeaderboard)(env),
    (dependencies.prediction || runStreamGoalPrediction)(env, now),
    (dependencies.maintenance || runScheduledMaintenance)(env, now),
  ];
  const results = await Promise.allSettled(tasks);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'other worker scheduled tasks failed');
  return results.map((result) => result.value);
}

export default {
  scheduled(controller, env, ctx) { return runOtherScheduled(controller, env, ctx); },
  fetch() { return new Response('Not found', { status: 404 }); },
};
