import { scheduleBuddyPlayback, scheduledTimestamp } from './buddy-playback-scheduler.js';
import coreApp from './scheduled-main.js';
import diagnosticApp from './health-alert-index.js';

export {
  resetBuddyPlaybackFlightForTests,
  scheduleBuddyPlayback,
  scheduledTimestamp,
} from './buddy-playback-scheduler.js';

export const DEFER_BUDDY_PLAYBACK_FLAG = '__DEFER_BUDDY_PLAYBACK';

export function shouldDeferBuddyPlayback(env = {}) {
  return Boolean(env?.[DEFER_BUDDY_PLAYBACK_FLAG]);
}

export default {
  async scheduled(controller, env, ctx) {
    const scheduledAt = scheduledTimestamp(controller);
    if (!shouldDeferBuddyPlayback(env)) scheduleBuddyPlayback(env, ctx, scheduledAt);
    return coreApp.scheduled(controller, env, ctx);
  },

  async fetch(request, env, ctx) {
    return diagnosticApp.fetch(request, env, ctx);
  },
};
