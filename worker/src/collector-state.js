import { jwtExpiryMs, normalizeBearer } from './shared.js';

export function collectorStateFromAuthState(authState, env = {}) {
  const authToken = normalizeBearer(authState?.authToken || env.STATIONHEAD_AUTH_TOKEN || env.SH_AUTH_TOKEN);
  const deviceUid = String(authState?.deviceUid || env.STATIONHEAD_DEVICE_UID || env.SH_DEVICE_UID || '').trim();
  if (!authToken || !deviceUid) {
    throw new Error('Stationhead session is missing. Set the SH_AUTH_TOKEN and SH_DEVICE_UID Worker secrets.');
  }
  return {
    authToken,
    deviceUid,
    tokenExpiresAt: jwtExpiryMs(authToken) || Number(authState?.tokenExpiresAt || 0),
    lastRunAt: Number(authState?.collectorLastRunAt || 0),
    lastSuccessAt: Number(authState?.collectorLastSuccessAt || 0),
    lastError: authState?.collectorLastError || null,
    channelId: Number(authState?.collectorChannelId || 0) || null,
    stationId: Number(authState?.collectorStationId || 0) || null,
  };
}

export async function loadCollectorState(env) {
  if (env.__shAuthState) {
    return collectorStateFromAuthState(env.__shAuthState, env);
  }

  const row = await env.DB.prepare(`
    SELECT auth_token, device_uid, token_expires_at, last_run_at, last_success_at,
           last_error, last_channel_id, last_station_id, updated_at
    FROM sh_worker_collector_state
    WHERE id = 'stationhead'
  `).first();

  const authToken = normalizeBearer(row?.auth_token || env.STATIONHEAD_AUTH_TOKEN || env.SH_AUTH_TOKEN);
  const deviceUid = String(row?.device_uid || env.STATIONHEAD_DEVICE_UID || env.SH_DEVICE_UID || '').trim();

  if (!authToken || !deviceUid) {
    throw new Error('Stationhead session is missing. Set the SH_AUTH_TOKEN and SH_DEVICE_UID Worker secrets.');
  }

  return {
    authToken,
    deviceUid,
    tokenExpiresAt: jwtExpiryMs(authToken) || Number(row?.token_expires_at || 0),
    lastRunAt: Number(row?.last_run_at || 0),
    lastSuccessAt: Number(row?.last_success_at || 0),
    lastError: row?.last_error || null,
    channelId: Number(row?.last_channel_id || 0) || null,
    stationId: Number(row?.last_station_id || 0) || null,
  };
}

export async function saveCollectorState(env, state, patch = {}) {
  Object.assign(state, patch);
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO sh_worker_collector_state (
      id, auth_token, device_uid, token_expires_at, last_run_at, last_success_at,
      last_error, last_channel_id, last_station_id, updated_at
    ) VALUES ('stationhead', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      auth_token=excluded.auth_token,
      device_uid=excluded.device_uid,
      token_expires_at=excluded.token_expires_at,
      last_run_at=excluded.last_run_at,
      last_success_at=excluded.last_success_at,
      last_error=excluded.last_error,
      last_channel_id=excluded.last_channel_id,
      last_station_id=excluded.last_station_id,
      updated_at=excluded.updated_at
  `).bind(
    state.authToken,
    state.deviceUid,
    state.tokenExpiresAt || jwtExpiryMs(state.authToken) || null,
    state.lastRunAt || null,
    state.lastSuccessAt || null,
    state.lastError || null,
    state.channelId || null,
    state.stationId || null,
    now,
  ).run();
}
