import { normalizeBearer, jwtExpiryMs } from './shared.js';

export const AUTH_STATE_SQL = `SELECT
  collector_state.auth_token,collector_state.device_uid,collector_state.token_expires_at,
  collector_state.last_run_at AS collector_last_run_at,
  collector_state.last_success_at AS collector_last_success_at,
  collector_state.last_error AS collector_last_error,
  collector_state.last_channel_id AS collector_channel_id,
  collector_state.last_station_id AS collector_station_id,
  collector_state.updated_at AS collector_updated_at,
  auth_control.id AS control_id,auth_control.last_attempt_at,auth_control.last_success_at,
  auth_control.last_error,auth_control.lock_until
FROM (SELECT ? AS id) requested
LEFT JOIN sh_worker_collector_state collector_state ON collector_state.id=requested.id
LEFT JOIN sh_worker_auth_control auth_control ON auth_control.id=requested.id`;

export function parseAuthState(row, env = {}) {
  const authToken = normalizeBearer(row?.auth_token || env.STATIONHEAD_AUTH_TOKEN);
  const deviceUid = String(row?.device_uid || env.STATIONHEAD_DEVICE_UID || '').trim();
  return {
    authToken,
    deviceUid,
    tokenExpiresAt: jwtExpiryMs(authToken) || Number(row?.token_expires_at || 0),
    lastAttemptAt: Number(row?.last_attempt_at || 0),
    lastSuccessAt: Number(row?.last_success_at || 0),
    lastError: row?.last_error || null,
    lockUntil: Number(row?.lock_until || 0),
    controlExists: Boolean(row?.control_id),
    collectorLastRunAt: Number(row?.collector_last_run_at || 0),
    collectorLastSuccessAt: Number(row?.collector_last_success_at || 0),
    collectorLastError: row?.collector_last_error || null,
    collectorChannelId: Number(row?.collector_channel_id || 0) || null,
    collectorStationId: Number(row?.collector_station_id || 0) || null,
    collectorUpdatedAt: Number(row?.collector_updated_at || 0),
  };
}

export async function readAuthState(env, stateId = 'stationhead') {
  const row = await env.DB.prepare(AUTH_STATE_SQL).bind(stateId).first();
  return parseAuthState(row, env);
}

export async function ensureAuthControlRow(env, stateId = 'stationhead', now = Date.now()) {
  await env.DB.prepare(`INSERT OR IGNORE INTO sh_worker_auth_control (id,updated_at) VALUES (?,?)`)
    .bind(stateId, now).run();
}
