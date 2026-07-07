import {
  DEFER_BUDDY_PLAYBACK_FLAG,
  scheduleBuddyPlayback,
  scheduledTimestamp,
} from './cadenced-entry.js';
import resilientApp from './resilient-entry.js';

export function withBuddyPlaybackDeferred(env = {}) {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === DEFER_BUDDY_PLAYBACK_FLAG) return true;
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      return property === DEFER_BUDDY_PLAYBACK_FLAG || Reflect.has(target, property);
    },
  });
}

function withoutWaitUntil(ctx) {
  if (!ctx || typeof ctx !== 'object') return ctx;
  return new Proxy(ctx, {
    get(target, property, receiver) {
      if (property === 'waitUntil') return undefined;
      return Reflect.get(target, property, receiver);
    },
  });
}

export async function runProductionScheduled(controller, env, ctx, dependencies = {}) {
  const scheduleBuddy = dependencies.scheduleBuddyPlayback || scheduleBuddyPlayback;
  const app = dependencies.app || resilientApp;
  const scheduledAt = scheduledTimestamp(controller);

  let primaryResult;
  let primaryError = null;
  try {
    primaryResult = await app.scheduled(controller, withBuddyPlaybackDeferred(env), ctx);
  } catch (error) {
    primaryError = error;
  }

  const buddyTask = (async () => {
    try {
      return await scheduleBuddy(env, withoutWaitUntil(ctx), scheduledAt);
    } catch (error) {
      console.error(JSON.stringify({
        event: 'buddy_playback_after_primary_failed',
        error: String(error?.message || error),
      }));
      return null;
    }
  })();
  if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(buddyTask);
  else await buddyTask;

  if (primaryError) throw primaryError;
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
