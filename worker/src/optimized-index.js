import collector from './index.js';
import { health as collectorHealth } from './collector-http.js';
import { jsonResponse as json, normalizeBearer, jwtExpiryMs, positiveNumber as positive } from './shared.js';
import { ensureAuthControlRow, readAuthState } from './auth-state.js';
import { combinedAbortSignal } from './request-signal.js';

const API_ORIGIN = 'https://production1.stationhead.com';
const STATE_ID = 'stationhead';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const nativeFetch = globalThis.fetch.bind(globalThis);

function authConfig(env) {
  return {
    alias: env.CHANNEL_ALIAS || 'buddies',
    appVersion: env.STATIONHEAD_APP_VERSION || env.SH_APP_VERSION || '1.0.0',
    requestTimeoutMs: Math.min(positive(env.REQUEST_TIMEOUT_MS, 20_000), 30_000),
    refreshBeforeMs: positive(env.AUTH_REFRESH_BEFORE_MS, 3_600_000),
    cooldownMs: positive(env.AUTH_REFRESH_COOLDOWN_MS, 300_000),
    backoffMs: positive(env.AUTH_FAILURE_BACKOFF_MS, 900_000),
    lockMs: positive(env.AUTH_LOCK_MS, 60_000),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isChatHistory(url) {
  return url.origin === API_ORIGIN && /\/station\/[^/]+\/chatHistory$/i.test(url.pathname);
}

function chatFallbackResponse(requestedLimit, reason) {
  console.warn(JSON.stringify({
    event: 'sh_chat_history_skipped',
    requested_limit: requestedLimit,
    reason,
  }));
  return new Response(JSON.stringify({ chats: { items: [], next: null } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

globalThis.fetch = async (input, init = {}) => {
  const rawUrl = typeof input === 'string' ? input : input?.url;
  if (!rawUrl) return nativeFetch(input, init);

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return nativeFetch(input, init);
  }
  if (!isChatHistory(url)) return nativeFetch(input, init);

  const requestedLimit = Math.max(1, Number(url.searchParams.get('limit')) || 50);
  const limits = [...new Set([requestedLimit, Math.min(requestedLimit, 20)])];
  let lastReason = 'unknown';

  for (const limit of limits) {
    const retryUrl = new URL(url);
    retryUrl.searchParams.set('limit', String(limit));
    try {
      const response = await nativeFetch(retryUrl.toString(), {
        ...init,
        headers: init.headers ? new Headers(init.headers) : undefined,
        signal: combinedAbortSignal(init.signal, 15_000),
      });

      if (response.status < 500) {
        if (limit !== requestedLimit) {
          console.warn(JSON.stringify({
            event: 'sh_chat_history_fallback',
            requested_limit: requestedLimit,
            successful_limit: limit,
          }));
        }
        return response;
      }

      lastReason = `HTTP ${response.status} at limit=${limit}`;
      await response.arrayBuffer().catch(() => {});
    } catch (error) {
      const message = String(error?.message || error);
      if (!/timeout|timed out|aborted/i.test(message)) throw error;
      lastReason = `${message} at limit=${limit}`;
    }
  }

  return chatFallbackResponse(requestedLimit, lastReason);
};

export function withAuthState(env, state) {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === '__shAuthState') return state;
      return Reflect.get(target, property, receiver);
    },
  });
}

async function claimAuthLock(env, cfg) {
  const now = Date.now();
  const result = await env.DB.prepare(`
    UPDATE sh_worker_auth_control
    SET lock_until = ?, last_attempt_at = ?, updated_at = ?
    WHERE id = ? AND COALESCE(lock_until, 0) < ?
  `).bind(now + cfg.lockMs, now, now, STATE_ID, now).run();
  return Number(result?.meta?.changes || 0) > 0;
}

async function waitForAuth(env, previousSuccessAt, cfg) {
  const deadline = Date.now() + Math.min(cfg.lockMs, 30_000);
  while (Date.now() < deadline) {
    await sleep(1_500);
    const state = await readAuthState(env, STATE_ID);
    if (state.lastSuccessAt > previousSuccessAt && state.authToken && state.deviceUid) return state;
    if (state.lockUntil <= Date.now()) break;
  }
  return null;
}

async function saveSession(env, authToken, deviceUid) {
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO sh_worker_collector_state (
      id, auth_token, device_uid, token_expires_at,
      last_run_at, last_success_at, last_error,
      last_channel_id, last_station_id, updated_at
    ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET
      auth_token = excluded.auth_token,
      device_uid = excluded.device_uid,
      token_expires_at = excluded.token_expires_at,
      updated_at = excluded.updated_at
  `).bind(STATE_ID, authToken, deviceUid, jwtExpiryMs(authToken) || null, now).run();
}

async function finishAuthAttempt(env, error = null) {
  const now = Date.now();
  await env.DB.prepare(`
    UPDATE sh_worker_auth_control
    SET last_success_at = CASE WHEN ? IS NULL THEN ? ELSE last_success_at END,
        last_error = ?, lock_until = 0, updated_at = ?
    WHERE id = ?
  `).bind(error, now, error, now, STATE_ID).run();
}

function shHeaders(cfg, deviceUid, authToken = '') {
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

async function shFetch(cfg, path, options = {}) {
  return nativeFetch(`${API_ORIGIN}${path}`, {
    ...options,
    signal: AbortSignal.timeout(cfg.requestTimeoutMs),
  });
}

async function acquireDirectSession(cfg) {
  const deviceUid = crypto.randomUUID();
  const baseHeaders = shHeaders(cfg, deviceUid);

  const tokenResponse = await shFetch(cfg, '/web/token', {
    method: 'POST',
    headers: baseHeaders,
    body: '',
  });
  const authToken = normalizeBearer(tokenResponse.headers.get('authorization'));
  if (!tokenResponse.ok || !authToken) {
    const body = await tokenResponse.text().catch(() => '');
    throw new Error(`guest token failed: status=${tokenResponse.status}, authorization=${Boolean(authToken)}${body ? `, body=${body.slice(0, 160)}` : ''}`);
  }

  const authHeaders = shHeaders(cfg, deviceUid, authToken);
  const loginResponse = await shFetch(cfg, '/web/guest/login', {
    method: 'POST',
    headers: authHeaders,
    body: '',
  });
  if (!loginResponse.ok) {
    const body = await loginResponse.text().catch(() => '');
    throw new Error(`guest login failed: status=${loginResponse.status}${body ? `, body=${body.slice(0, 160)}` : ''}`);
  }

  const verifyResponse = await shFetch(cfg, `/channels/alias/${encodeURIComponent(cfg.alias)}`, {
    headers: authHeaders,
  });
  if (!verifyResponse.ok) {
    const body = await verifyResponse.text().catch(() => '');
    throw new Error(`guest verification failed: status=${verifyResponse.status}${body ? `, body=${body.slice(0, 160)}` : ''}`);
  }
  await verifyResponse.arrayBuffer().catch(() => {});
  return { authToken, deviceUid };
}

async function refreshSession(env, reason, force = false) {
  const cfg = authConfig(env);
  const initial = await readAuthState(env, STATE_ID);
  const now = Date.now();

  if (!force && initial.lastError && initial.lastAttemptAt && now - initial.lastAttemptAt < cfg.backoffMs) {
    return null;
  }

  if (!initial.controlExists) await ensureAuthControlRow(env, STATE_ID, now);
  if (!await claimAuthLock(env, cfg)) {
    return waitForAuth(env, initial.lastSuccessAt, cfg);
  }

  try {
    const credentials = await acquireDirectSession(cfg);
    await saveSession(env, credentials.authToken, credentials.deviceUid);
    await finishAuthAttempt(env, null);
    const state = await readAuthState(env, STATE_ID);
    console.log(JSON.stringify({
      event: 'sh_auth_refreshed',
      method: 'direct-api',
      reason,
      token_expires_at: state.tokenExpiresAt || null,
    }));
    return state;
  } catch (error) {
    const message = String(error?.message || error).slice(0, 800);
    await finishAuthAttempt(env, message).catch(() => {});
    throw new Error(`Stationhead authentication failed: ${message}`);
  }
}

async function ensureSession(env) {
  const cfg = authConfig(env);
  const state = await readAuthState(env, STATE_ID);
  const ready = Boolean(state.authToken && state.deviceUid);
  const expiresSoon = Boolean(state.tokenExpiresAt && state.tokenExpiresAt - Date.now() <= cfg.refreshBeforeMs);

  if (ready && !expiresSoon) return state;
  if (ready && state.lastSuccessAt && Date.now() - state.lastSuccessAt < cfg.cooldownMs) return state;

  return refreshSession(env, ready ? 'token-near-expiry' : 'initial-session');
}

function is401(value) {
  return /\b401\b|session expired/i.test(String(value?.message || value));
}

export function authHealth(state) {
  return {
    auth_method: 'direct-api',
    auth_session_ready: Boolean(state?.authToken && state?.deviceUid),
    auth_token_expires_at: state?.tokenExpiresAt || null,
    auth_last_attempt_at: state?.lastAttemptAt || null,
    auth_last_success_at: state?.lastSuccessAt || null,
    auth_last_error: state?.lastError || null,
    browser_binding: false,
    browser_session_ready: Boolean(state?.authToken && state?.deviceUid),
    browser_token_expires_at: state?.tokenExpiresAt || null,
    browser_last_auth_attempt_at: state?.lastAttemptAt || null,
    browser_last_auth_success_at: state?.lastSuccessAt || null,
    browser_last_auth_error: state?.lastError || null,
  };
}

export async function runOptimizedScheduled(controller, env, ctx, dependencies = {}) {
  const ensure = dependencies.ensureSession || ensureSession;
  const refresh = dependencies.refreshSession || refreshSession;
  const runCollector = dependencies.collectorScheduled || collector.scheduled;
  try {
    let state = await ensure(env);
    if (!state?.authToken || !state?.deviceUid) {
      console.warn(JSON.stringify({ event: 'sh_auth_backoff' }));
      return;
    }

    try {
      await runCollector(controller, withAuthState(env, state), ctx);
    } catch (error) {
      if (!is401(error)) throw error;
      state = await refresh(env, 'api-401', true);
      if (!state) throw error;
      await runCollector(controller, withAuthState(env, state), ctx);
    }
  } catch (error) {
    console.error(error);
    throw error;
  }
}

export async function readOptimizedHealth(env) {
  const state = await readAuthState(env, STATE_ID);
  const base = await collectorHealth(withAuthState(env, state));
  return json({ ...base, ...authHealth(state) });
}

export async function handleOptimizedRequest() {
  return json({ ok: false, error: 'not found' }, 404);
}

export default {
  scheduled: runOptimizedScheduled,
  fetch: handleOptimizedRequest,
};
