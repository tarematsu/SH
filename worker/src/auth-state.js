import { normalizeBearer, jwtExpiryMs } from './shared.js';

export const AUTH_STATE_SQL = `SELECT
  session.auth_token,session.device_uid,session.token_expires_at,
  control.id AS control_id,control.last_attempt_at,control.last_success_at,
  control.last_error,control.lock_until
FROM (SELECT ? AS id) requested
LEFT JOIN sh_worker_collector_state session ON session.id=requested.id
LEFT JOIN sh_worker_auth_control control ON control.id=requested.id`;

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
