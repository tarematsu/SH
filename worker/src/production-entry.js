import './fetch-guard.js';
import primaryApp from './scheduled-main.js';

export async function runProductionScheduled(controller, env, ctx, dependencies = {}) {
  const app = dependencies.app || primaryApp;
  return app.scheduled(controller, env, ctx);
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
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
