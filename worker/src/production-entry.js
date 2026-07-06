import {
  scheduleBuddyPlayback,
  scheduledTimestamp,
} from './cadenced-entry.js';
import resilientApp from './resilient-entry.js';

async function runBuddyPlaybackAfterPrimary(scheduleBuddy, env, ctx, scheduledAt) {
  try {
    return await scheduleBuddy(env, ctx, scheduledAt);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'buddy_playback_after_primary_failed',
      error: String(error?.message || error),
    }));
    return null;
  }
}

export async function runProductionScheduled(controller, env, ctx, dependencies = {}) {
  const scheduleBuddy = dependencies.scheduleBuddyPlayback || scheduleBuddyPlayback;
  const app = dependencies.app || resilientApp;
  const scheduledAt = scheduledTimestamp(controller);

  const primaryResult = await app.scheduled(controller, env, ctx);
  const buddyTask = runBuddyPlaybackAfterPrimary(scheduleBuddy, env, ctx, scheduledAt);
  if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(buddyTask);
  else await buddyTask;
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
