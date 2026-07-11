import resilientApp from './resilient-entry.js';

export async function runProductionScheduled(controller, env, ctx, dependencies = {}) {
  const app = dependencies.app || resilientApp;
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
    return resilientApp.fetch(request, env, ctx);
  },
};
