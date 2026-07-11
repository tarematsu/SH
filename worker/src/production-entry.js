import { DEFER_BUDDY_PLAYBACK_FLAG } from './cadenced-entry.js';
import { DEFER_AUXILIARY_RUNNERS_FLAG } from './scheduled-main.js';
import resilientApp from './resilient-entry.js';

export function withBuddyPlaybackDeferred(env = {}) {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === DEFER_BUDDY_PLAYBACK_FLAG) return true;
      if (property === DEFER_AUXILIARY_RUNNERS_FLAG) return true;
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      return property === DEFER_BUDDY_PLAYBACK_FLAG
        || property === DEFER_AUXILIARY_RUNNERS_FLAG
        || Reflect.has(target, property);
    },
  });
}

export async function runProductionScheduled(controller, env, ctx, dependencies = {}) {
  const app = dependencies.app || resilientApp;
  return app.scheduled(controller, withBuddyPlaybackDeferred(env), ctx);
}

export async function runProductionCron(controller, env, ctx, dependencies = {}) {
  return runProductionScheduled(controller, env, ctx, dependencies);
}

function isFaviconRequest(request) {
  return request.method === 'GET' && new URL(request.url).pathname === '/favicon.ico';
}

export default {
  async scheduled(controller, env, ctx) {
    return runProductionCron(controller, env, ctx);
  },

  async fetch(request, env, ctx) {
    if (isFaviconRequest(request)) return new Response(null, { status: 204 });
    return resilientApp.fetch(request, env, ctx);
  },
};
