import { ensureAuthControlRow, readAuthState } from './auth-state.js';
import { jwtExpiryMs, normalizeBearer } from './shared.js';

const API_ORIGIN = 'https://production1.stationhead.com';
const DEFAULT_STATE_ID = 'sakurazaka46jp';
const DEFAULT_HANDLE = 'sakurazaka46jp';
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const AUTH_REFRESH_MARGIN_MS = 5 * 60_000;
const AUTH_LOCK_MS = 60_000;
const AUTH_WAIT_MS = 15_000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

function positive(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(number, maximum);
}

export function sakurazakaAuthStateId(env = {}) {
  return String(env.SAKURAZAKA_AUTH_STATE_ID || DEFAULT_STATE_ID).trim().toLowerCase()
    || DEFAULT_STATE_ID;
}

function config(env = {}) {
  return {
    stateId: sakurazakaAuthStateId(env),
    handle: String(env.SOLO_BROADCAST_HANDLE || DEFAULT_HANDLE).trim().toLowerCase() || DEFAULT_HANDLE,
    appVersion: String(env.STATIONHEAD_APP_VERSION || env.SH_APP_VERSION || '1.0.0'),
    timeoutMs: positive(env.REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 30_000),
  };
}

function scopedEnv(env) {
  if (!env?.OTHER_DB) throw new Error('OTHER_DB binding is missing for Sakurazaka authentication');
  return { ...env, DB: env.OTHER_DB };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usableSession(state, now = Date.now()) {
  if (!state?.authToken || !state?.deviceUid) return false;
  return !state.tokenExpiresAt || state.tokenExpiresAt - now > AUTH_REFRESH_MARGIN_MS;
}

function headers(cfg, deviceUid, authToken = '') {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
    'app-platform': 'web',
    'app-version': cfg.appVersion,
    'content-type': 'application/json',
    origin: 'https://www.stationhead.com',
    referer: 'https://www.stationhead.com/',
    'sth-device-uid': deviceUid,
    'user-agent': USER_AGENT,
    ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
  };
}

async function stationheadFetch(cfg, path, init = {}, request = fetch) {
  return request(`${API_ORIGIN}${path}`, {
    ...init,
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
}

async function acquireDirectSession(env, request = fetch) {
  const cfg = config(env);
  const deviceUid = crypto.randomUUID();
  const tokenResponse = await stationheadFetch(cfg, '/web/token', {
    method: 'POST',
    headers: headers(cfg, deviceUid),
    body: '',
  }, request);
  const authToken = normalizeBearer(tokenResponse.headers.get('authorization'));
  if (!tokenResponse.ok || !authToken) {
    const body = await tokenResponse.text().catch(() => '');
    throw new Error(`Stationhead guest token failed: status=${tokenResponse.status}${body ? `, body=${body.slice(0, 160)}` : ''}`);
  }

  const authHeaders = headers(cfg, deviceUid, authToken);
  const loginResponse = await stationheadFetch(cfg, '/web/guest/login', {
    method: 'POST',
    headers: authHeaders,
    body: '',
  }, request);
  if (!loginResponse.ok) {
    const body = await loginResponse.text().catch(() => '');
    throw new Error(`Stationhead guest login failed: status=${loginResponse.status}${body ? `, body=${body.slice(0, 160)}` : ''}`);
  }

  const verifyResponse = await stationheadFetch(
    cfg,
    `/station/handle/${encodeURIComponent(cfg.handle)}/guest`,
    { method: 'POST', headers: authHeaders, body: '' },
    request,
  );
  if (!verifyResponse.ok) {
    const body = await verifyResponse.text().catch(() => '');
    throw new Error(`Stationhead guest verification failed: status=${verifyResponse.status}${body ? `, body=${body.slice(0, 160)}` : ''}`);
  }
  await verifyResponse.arrayBuffer().catch(() => {});
  return { authToken, deviceUid, tokenExpiresAt: jwtExpiryMs(authToken) || null };
}

async function saveSession(env, stateId, state, now = Date.now()) {
  await env.DB.prepare(`INSERT INTO sh_worker_collector_state (
      id,auth_token,device_uid,token_expires_at,last_run_at,last_success_at,last_error,
      last_channel_id,last_station_id,updated_at
    ) VALUES (?,?,?,?,NULL,NULL,NULL,NULL,NULL,?)
    ON CONFLICT(id) DO UPDATE SET
      auth_token=excluded.auth_token,
      device_uid=excluded.device_uid,
      token_expires_at=excluded.token_expires_at,
      updated_at=excluded.updated_at`)
    .bind(stateId, state.authToken, state.deviceUid, state.tokenExpiresAt, now)
    .run();
}

async function finishRefresh(env, stateId, error = null, now = Date.now()) {
  await env.DB.prepare(`UPDATE sh_worker_auth_control SET
      last_success_at=CASE WHEN ? IS NULL THEN ? ELSE last_success_at END,
      last_error=?,lock_until=0,updated_at=? WHERE id=?`)
    .bind(error, now, error, now, stateId)
    .run();
}

async function claimRefresh(env, stateId, now = Date.now()) {
  await ensureAuthControlRow(env, stateId, now);
  const result = await env.DB.prepare(`UPDATE sh_worker_auth_control SET
      lock_until=?,last_attempt_at=?,updated_at=?
    WHERE id=? AND COALESCE(lock_until,0)<?`)
    .bind(now + AUTH_LOCK_MS, now, now, stateId, now)
    .run();
  return Number(result?.meta?.changes || 0) > 0;
}

async function waitForRefresh(env, stateId, previousSuccessAt, nowFn = Date.now) {
  const deadline = nowFn() + AUTH_WAIT_MS;
  while (nowFn() < deadline) {
    await sleep(1_000);
    const state = await readAuthState(env, stateId);
    if (state.lastSuccessAt > previousSuccessAt && usableSession(state, nowFn())) return state;
    if (state.lockUntil <= nowFn()) break;
  }
  return null;
}

export async function ensureSakurazakaSession(env, dependencies = {}, options = {}) {
  const active = scopedEnv(env);
  const cfg = config(env);
  const nowFn = dependencies.now || Date.now;
  const now = nowFn();
  const initial = await readAuthState(active, cfg.stateId);
  if (!options.force && usableSession(initial, now)) return initial;

  if (!await claimRefresh(active, cfg.stateId, now)) {
    const waited = await waitForRefresh(active, cfg.stateId, initial.lastSuccessAt, nowFn);
    if (waited) return waited;
    throw new Error('Sakurazaka authentication refresh lock timed out');
  }

  try {
    const acquired = await (dependencies.acquireSession || acquireDirectSession)(
      env,
      dependencies.fetch,
    );
    await saveSession(active, cfg.stateId, acquired, nowFn());
    await finishRefresh(active, cfg.stateId, null, nowFn());
    return readAuthState(active, cfg.stateId);
  } catch (error) {
    const message = String(error?.message || error).slice(0, 800);
    await finishRefresh(active, cfg.stateId, message, nowFn()).catch(() => {});
    throw error;
  }
}
