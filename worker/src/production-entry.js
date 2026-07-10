import {
  DEFER_BUDDY_PLAYBACK_FLAG,
  scheduleBuddyPlayback,
  scheduledTimestamp,
} from './cadenced-entry.js';
import resilientApp from './resilient-entry.js';
import shRefactorBundle from './sh-refactor-bundle.generated.js';

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

export async function runProductionScheduled(controller, env, ctx, dependencies = {}) {
  const scheduleBuddy = dependencies.scheduleBuddyPlayback || scheduleBuddyPlayback;
  const app = dependencies.app || resilientApp;
  const scheduledAt = scheduledTimestamp(controller);
  const buddyCtx = !ctx || typeof ctx !== 'object' ? ctx : new Proxy(ctx, {
    get(target, property, receiver) {
      if (property === 'waitUntil') return undefined;
      return Reflect.get(target, property, receiver);
    },
  });

  let primaryResult;
  let primaryError = null;
  try {
    primaryResult = await app.scheduled(controller, withBuddyPlaybackDeferred(env), ctx);
  } catch (error) {
    primaryError = error;
  }

  const buddyTask = (async () => {
    try {
      return await scheduleBuddy(env, buddyCtx, scheduledAt);
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

function isFaviconRequest(request) {
  return request.method === 'GET' && new URL(request.url).pathname === '/favicon.ico';
}

function isShRefactorBundleRequest(request) {
  return request.method === 'GET'
    && new URL(request.url).pathname === '/__sh_bundle_7b4f10c95a2e4d8fa6.json';
}

export default {
  async scheduled(controller, env, ctx) {
    return runProductionScheduled(controller, env, ctx);
  },

  async fetch(request, env, ctx) {
    if (isFaviconRequest(request)) return new Response(null, { status: 204 });
    if (isShRefactorBundleRequest(request)) {
      return Response.json(shRefactorBundle, {
        headers: { 'cache-control': 'no-store' },
      });
    }
    return resilientApp.fetch(request, env, ctx);
  },
};
