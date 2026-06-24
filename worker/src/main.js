import app from './email-recap-index.js';
import { runCloudWeeklyLeaderboard } from './cloud-weekly-leaderboard.js';

function normalizeHealthPayload(payload) {
  if (payload?.cloud_solo_phase === 'idle') {
    if (payload.cloud_solo_session_id === 0) payload.cloud_solo_session_id = null;
    if (payload.cloud_solo_station_id === 0) payload.cloud_solo_station_id = null;
  }
  return payload;
}

export default {
  async scheduled(controller, env, ctx) {
    await app.scheduled(controller, env, ctx);
    ctx.waitUntil(runCloudWeeklyLeaderboard(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const response = await app.fetch(request, env, ctx);
    if (request.method !== 'GET' || (url.pathname !== '/' && url.pathname !== '/health')) {
      return response;
    }

    const payload = await response.json().catch(() => null);
    if (!payload) return response;
    return new Response(JSON.stringify(normalizeHealthPayload(payload), null, 2), {
      status: response.status,
      headers: response.headers,
    });
  },
};
