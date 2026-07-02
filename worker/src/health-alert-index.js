import app from './main.js';
import { getCollectorHealthView, runCollectorHealthAlert } from './health-alert.js';

export default {
  async scheduled(controller, env, ctx) {
    try {
      await app.scheduled(controller, env, ctx);
    } finally {
      await runCollectorHealthAlert(env).catch((error) => {
        console.error(JSON.stringify({ event: 'collector_health_alert_failed', error: String(error?.message || error) }));
      });
    }
  },

  async fetch(request, env, ctx) {
    const response = await app.fetch(request, env, ctx);
    const url = new URL(request.url);
    if (request.method !== 'GET' || (url.pathname !== '/' && url.pathname !== '/health')) return response;
    const [payload, collectorHealth] = await Promise.all([
      response.json().catch(() => null),
      getCollectorHealthView(env).catch((error) => {
        console.error(JSON.stringify({
          event: 'collector_health_view_failed',
          error: String(error?.message || error),
        }));
        return {
          collector_health_ok: false,
          collector_health_error: 'health_check_failed',
        };
      }),
    ]);
    if (!payload) return response;
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store');
    return new Response(JSON.stringify({ ...payload, ...collectorHealth }), {
      status: response.status,
      headers,
    });
  },
};
