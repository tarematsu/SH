import {
  scheduleBuddyPlayback,
  scheduledTimestamp,
} from './cadenced-entry.js';
import resilientApp from './resilient-entry.js';

export async function runProductionScheduled(controller, env, ctx, dependencies = {}) {
  const scheduleBuddy = dependencies.scheduleBuddyPlayback || scheduleBuddyPlayback;
  const app = dependencies.app || resilientApp;
  const scheduledAt = scheduledTimestamp(controller);
  const buddyTask = Promise.resolve(scheduleBuddy(env, ctx, scheduledAt));
  const primaryTask = Promise.resolve(app.scheduled(controller, env, ctx));

  const [primaryResult] = await Promise.all([
    primaryTask,
    buddyTask.catch((error) => {
      console.error(JSON.stringify({
        event: 'buddy_playback_wait_failed',
        error: String(error?.message || error),
      }));
      return null;
    }),
  ]);
  return primaryResult;
}

export default {
  async scheduled(controller, env, ctx) {
    return runProductionScheduled(controller, env, ctx);
  },

  async fetch(request, env, ctx) {
    return resilientApp.fetch(request, env, ctx);
  },
};
