import { jsonResponse as json } from './shared.js';
import { runCollection } from './collector-runner.js';

export function authorized(request, env) {
  const expected = String(env.RUN_SECRET || '').trim();
  return Boolean(expected) && request.headers.get('authorization') === `Bearer ${expected}`;
}

export async function health(env) {
  if (!env.DB) return { ok: false, error: 'DB binding is missing' };
  const cached = env.__shAuthState;
  const row = cached ? {
    token_expires_at: cached.tokenExpiresAt || null,
    last_run_at: cached.collectorLastRunAt || null,
    last_success_at: cached.collectorLastSuccessAt || null,
    last_error: cached.collectorLastError || null,
    last_channel_id: cached.collectorChannelId || null,
    last_station_id: cached.collectorStationId || null,
    updated_at: cached.collectorUpdatedAt || null,
  } : await env.DB.prepare(`
    SELECT token_expires_at, last_run_at, last_success_at, last_error,
           last_channel_id, last_station_id, updated_at
    FROM sh_worker_collector_state
    WHERE id = 'stationhead'
  `).first();
  return {
    ok: true,
    configured: Boolean(cached?.authToken && cached?.deviceUid)
      || Boolean(row || ((env.STATIONHEAD_AUTH_TOKEN || env.SH_AUTH_TOKEN) && (env.STATIONHEAD_DEVICE_UID || env.SH_DEVICE_UID))),
    token_expires_at: row?.token_expires_at || null,
    last_run_at: row?.last_run_at || null,
    last_success_at: row?.last_success_at || null,
    last_error: row?.last_error || null,
    channel_id: row?.last_channel_id || null,
    station_id: row?.last_station_id || null,
    updated_at: row?.updated_at || null,
  };
}

export async function handleCollectorRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return json(await health(env));
  }
  if (request.method === 'POST' && url.pathname === '/run') {
    if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
    try {
      return json(await runCollection(env, 'http'));
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: error?.message || String(error) }, 500);
    }
  }
  return json({ ok: false, error: 'not found' }, 404);
}
