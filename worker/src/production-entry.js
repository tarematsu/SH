import {
  scheduleBuddyPlayback,
  scheduledTimestamp,
} from './cadenced-entry.js';
import resilientApp from './resilient-entry.js';

export async function runProductionScheduled(controller, env, ctx, dependencies = {}) {
  const scheduleBuddy = dependencies.scheduleBuddyPlayback || scheduleBuddyPlayback;
  const app = dependencies.app || resilientApp;
  scheduleBuddy(env, ctx, scheduledTimestamp(controller));
  return app.scheduled(controller, env, ctx);
}

export default {
  async scheduled(controller, env, ctx) {
    return runProductionScheduled(controller, env, ctx);
  },

  async fetch(request, env, ctx) {
    return resilientApp.fetch(request, env, ctx);
  },
};
