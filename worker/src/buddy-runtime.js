import { BUDDY_AUTH_STATE_ID, ensureAuthControlRow, readAuthState } from './auth-state.js';
import { collectBuddyPlayback } from './buddy-playback.js';
import { jwtExpiryMs, normalizeBearer } from './shared.js';

const API_ORIGIN = 'https://production1.stationhead.com';
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const AUTH_REFRESH_MARGIN_MS = 5 * 60_000;
const AUTH_LOCK_MS = 60_000;
const AUTH_WAIT_MS = 15_000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

export const BUDDY_PLAYBACK_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS sh_playback_channel_current (
  channel_alias TEXT PRIMARY KEY,
  station_id INTEGER,
  queue_id INTEGER,
  start_time INTEGER,
  is_paused INTEGER NOT NULL DEFAULT 0,
  is_broadcasting INTEGER NOT NULL DEFAULT 0,
  host_account_id INTEGER,
  host_handle TEXT,
  state_hash TEXT NOT NULL,
  queue_json TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  changed_at INTEGER NOT NULL
)`;

let schemaReady = false;

function positive(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(number, maximum);
}

export function buddyAuthStateId(env = {}) {
  return String(env.BUDDY_PLAYBACK_AUTH_STATE_ID || BUDDY_AUTH_STATE_ID).trim().toLowerCase()
    || BUDDY_AUTH_STATE_ID;
}

function config(env = {}) {
  return {
    alias: String(env.BUDDY_PLAYBACK_ALIAS || 'buddy46').trim().toLowerCase() || 'buddy46',
    authStateId: buddyAuthStateId(env),
    appVersion: String(env.STATIONHEAD_APP_VERSION || env.SH_APP_VERSION || '1.0.0'),
    timeoutMs: positive(env.REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 30_000),
  };
}

export function buddyHandleStationPath(alias = 'buddy46') {
  return `/station/handle/${encodeURIComponent(String(alias || 'buddy46').trim().toLowerCase() || 'buddy46')}/guest`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usableSession(state, now = Date.now()) {
  if (!state?.authToken || !state?.deviceUid) return false;
  return !state.tokenExpiresAt || state.tokenExpiresAt - now > AUTH_REFRESH_MARGIN_MS;
}

function withBuddyAuthState(env, state) {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === '__buddyAuthState') return state;
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      return property === '__buddyAuthState' || Reflect.has(target, property);
    },
  });
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

async function shFetch(cfg, path, init = {}, request = fetch) {
  return request(`${API_ORIGIN}${path}`, {
    ...init,
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
}

async function acquireDirectSession(env, request = fetch) {
  const cfg = config(env);
  const deviceUid = crypto.randomUUID();
  const tokenResponse = await shFetch(cfg, '/web/token', {
    method: 'POST',
    headers: headers(cfg, deviceUid),
    body: '',
  }, request);
  const authToken = normalizeBearer(tokenResponse.headers.get('authorization'));
  if (!tokenResponse.ok || !authToken) {
    const body = await tokenResponse.text().catch(() => '');
    throw new Error(`buddy46 guest token failed: status=${tokenResponse.status}${body ? `, body=${body.slice(0, 160)}` : ''}`);
  }

  const authHeaders = headers(cfg, deviceUid, authToken);
  const loginResponse = await shFetch(cfg, '/web/guest/login', {
    method: 'POST',
    headers: authHeaders,
    body: '',
  }, request);
  if (!loginResponse.ok) {
    const body = await loginResponse.text().catch(() => '');
    throw new Error(`buddy46 guest login failed: status=${loginResponse.status}${body ? `, body=${body.slice(0, 160)}` : ''}`);
  }

  const verifyResponse = await shFetch(
    cfg,
    buddyHandleStationPath(cfg.alias),
    { method: 'POST', headers: authHeaders, body: '' },
    request,
  );
  if (!verifyResponse.ok) {
    const body = await verifyResponse.text().catch(() => '');
    throw new Error(`buddy46 guest verification failed: status=${verifyResponse.status}${body ? `, body=${body.slice(0, 160)}` : ''}`);
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

async function refreshSession(env, dependencies = {}, options = {}) {
  const cfg = config(env);
  const stateId = cfg.authStateId;
  const nowFn = dependencies.now || Date.now;
  const now = nowFn();
  const initial = await readAuthState(env, stateId);
  if (!options.force && usableSession(initial, now)) return initial;

  if (!await claimRefresh(env, stateId, now)) {
    const waited = await waitForRefresh(env, stateId, initial.lastSuccessAt, nowFn);
    if (waited) return waited;
    throw new Error('buddy46 authentication refresh lock timed out');
  }

  try {
    const acquired = await (dependencies.acquireSession || acquireDirectSession)(
      env,
      dependencies.fetch,
    );
    await saveSession(env, stateId, acquired, nowFn());
    await finishRefresh(env, stateId, null, nowFn());
    return readAuthState(env, stateId);
  } catch (error) {
    const message = String(error?.message || error).slice(0, 800);
    await finishRefresh(env, stateId, message, nowFn()).catch(() => {});
    throw error;
  }
}

export async function ensureBuddyPlaybackSchema(env) {
  if (!env?.DB) throw new Error('buddy46 D1 binding is missing');
  if (schemaReady) return false;
  await env.DB.prepare(BUDDY_PLAYBACK_SCHEMA_SQL).run();
  schemaReady = true;
  return true;
}

function isAuthFailure(error) {
  return /\b401\b|\b403\b|session expired|unauthori[sz]ed|Stationhead buddy playback API\s+404|Not in database/i
    .test(String(error?.message || error));
}

// sh_worker_collector_state/sh_worker_auth_control/sh_playback_channel_current
// are shared, alias-keyed tables (auth-state.js's functions also serve
// buddies' own primary loop under the 'stationhead' id) -- schema init and
// session refresh for buddy46 specifically run against OTHER_DB, via this
// scoped substitute env, so buddy46's rows never touch buddies' database.
// The actual playback collection below still gets the real env, since it
// also enriches sh_track_metadata, a cache genuinely shared with buddies'
// own collection and minute-facts derivation.
function otherDbEnv(env) {
  return { ...env, DB: env.OTHER_DB };
}

export async function collectBuddyPlaybackReady(env, observedAt = Date.now(), dependencies = {}) {
  const otherEnv = otherDbEnv(env);
  await ensureBuddyPlaybackSchema(otherEnv);
  let state = await refreshSession(otherEnv, dependencies);

  const collect = dependencies.collect || collectBuddyPlayback;
  try {
    return await collect(withBuddyAuthState(env, state), observedAt, dependencies);
  } catch (error) {
    if (!isAuthFailure(error)) throw error;
    state = await refreshSession(otherEnv, dependencies, { force: true });
    return collect(withBuddyAuthState(env, state), observedAt, dependencies);
  }
}

export function resetBuddyRuntimeForTests() {
  schemaReady = false;
}
