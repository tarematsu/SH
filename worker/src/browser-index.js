import puppeteer from '@cloudflare/puppeteer';
import collector from './index.js';

const API_BASE = 'https://production1.stationhead.com';
const STATE_ID = 'stationhead';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function normalizeBearer(value) {
  return String(value || '').replace(/^Bearer\s+/i, '').trim();
}

function jwtExpiryMs(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return 0;
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded));
    return Number(payload.exp || 0) * 1000;
  } catch {
    return 0;
  }
}

function positiveNumber(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function configFromEnv(env) {
  return {
    channelAlias: env.CHANNEL_ALIAS || 'buddies',
    timeoutMs: Math.min(positiveNumber(env.BROWSER_TIMEOUT_MS, 40_000), 55_000),
    refreshBeforeMs: positiveNumber(env.AUTH_REFRESH_BEFORE_MS, 60 * 60 * 1000),
    cooldownMs: positiveNumber(env.AUTH_REFRESH_COOLDOWN_MS, 5 * 60 * 1000),
    failureBackoffMs: positiveNumber(env.AUTH_FAILURE_BACKOFF_MS, 15 * 60 * 1000),
    lockMs: positiveNumber(env.AUTH_LOCK_MS, 90_000),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureControlRow(env) {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO sh_worker_auth_control (id, updated_at)
    VALUES (?, ?)
  `).bind(STATE_ID, Date.now()).run();
}

async function readAuthState(env) {
  await ensureControlRow(env);
  const [session, control] = await Promise.all([
    env.DB.prepare(`
      SELECT auth_token, device_uid, token_expires_at
      FROM sh_worker_collector_state WHERE id = ?
    `).bind(STATE_ID).first(),
    env.DB.prepare(`
      SELECT last_attempt_at, last_success_at, last_error, lock_until
      FROM sh_worker_auth_control WHERE id = ?
    `).bind(STATE_ID).first(),
  ]);

  const authToken = normalizeBearer(session?.auth_token || env.STATIONHEAD_AUTH_TOKEN);
  const deviceUid = String(session?.device_uid || env.STATIONHEAD_DEVICE_UID || '').trim();
  return {
    authToken,
    deviceUid,
    tokenExpiresAt: jwtExpiryMs(authToken) || Number(session?.token_expires_at || 0),
    lastAttemptAt: Number(control?.last_attempt_at || 0),
    lastSuccessAt: Number(control?.last_success_at || 0),
    lastError: control?.last_error || null,
    lockUntil: Number(control?.lock_until || 0),
  };
}

function needsRefresh(state, config) {
  if (!state.authToken || !state.deviceUid) return true;
  return Boolean(state.tokenExpiresAt) && state.tokenExpiresAt - Date.now() <= config.refreshBeforeMs;
}

async function claimLock(env, config) {
  const now = Date.now();
  const result = await env.DB.prepare(`
    UPDATE sh_worker_auth_control
    SET lock_until = ?, last_attempt_at = ?, updated_at = ?
    WHERE id = ? AND COALESCE(lock_until, 0) < ?
  `).bind(now + config.lockMs, now, now, STATE_ID, now).run();
  return Number(result?.meta?.changes || 0) > 0;
}

async function waitForOtherRefresh(env, previousSuccessAt, config) {
  const deadline = Date.now() + Math.min(config.lockMs, 45_000);
  while (Date.now() < deadline) {
    await sleep(2_000);
    const state = await readAuthState(env);
    if (state.lastSuccessAt > previousSuccessAt && state.authToken && state.deviceUid) return state;
    if (state.lockUntil <= Date.now()) return null;
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

function authBlocked(state, config, ignoreBackoff) {
  if (ignoreBackoff) return null;
  const now = Date.now();
  if (state.lastError && state.lastAttemptAt && now - state.lastAttemptAt < config.failureBackoffMs) {
    return `Browser Run authentication is in backoff until ${new Date(state.lastAttemptAt + config.failureBackoffMs).toISOString()}`;
  }
  if (state.lastSuccessAt && state.authToken && now - state.lastSuccessAt < config.cooldownMs) {
    return `Browser Run authentication was refreshed recently; retry after ${new Date(state.lastSuccessAt + config.cooldownMs).toISOString()}`;
  }
  return null;
}

async function captureGuestSession(env, config) {
  if (!env.BROWSER) throw new Error('Browser Run binding BROWSER is missing');
  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setUserAgent(DEFAULT_USER_AGENT);
    await page.setExtraHTTPHeaders({ 'accept-language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7' });
    page.setDefaultNavigationTimeout(config.timeoutMs);
    page.setDefaultTimeout(config.timeoutMs);

    const targetPath = `/channels/alias/${encodeURIComponent(config.channelAlias)}`;
    let settled = false;
    const credentials = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Timed out waiting for Stationhead guest credentials'));
      }, config.timeoutMs);

      const inspect = (request) => {
        if (settled) return;
        try {
          const url = new URL(request.url());
          if (url.origin !== API_BASE || url.pathname !== targetPath || request.method() !== 'GET') return;
          const headers = request.headers();
          const authToken = normalizeBearer(headers.authorization);
          const deviceUid = String(headers['sth-device-uid'] || '').trim();
          if (!authToken || !deviceUid) return;
          settled = true;
          clearTimeout(timer);
          resolve({ authToken, deviceUid });
        } catch {
          // Ignore unrelated requests.
        }
      };

      page.on('request', inspect);
      page.on('response', (response) => inspect(response.request()));
    });

    await page.goto(`https://www.stationhead.com/c/${encodeURIComponent(config.channelAlias)}`, {
      waitUntil: 'domcontentloaded',
      timeout: config.timeoutMs,
    });
    return await credentials;
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function refreshSession(env, reason, { ignoreBackoff = false } = {}) {
  const config = configFromEnv(env);
  const initial = await readAuthState(env);
  const blocked = authBlocked(initial, config, ignoreBackoff);
  if (blocked) throw new Error(blocked);

  const claimed = await claimLock(env, config);
  if (!claimed) {
    const refreshed = await waitForOtherRefresh(env, initial.lastSuccessAt, config);
    if (refreshed) return refreshed;
    throw new Error('Another Browser Run authentication attempt is still in progress');
  }

  try {
    const credentials = await captureGuestSession(env, config);
    await saveSession(env, credentials.authToken, credentials.deviceUid);
    await finishAuthAttempt(env, null);
    const state = await readAuthState(env);
    console.log(JSON.stringify({
      event: 'stationhead_auth_refreshed',
      reason,
      token_expires_at: state.tokenExpiresAt || null,
    }));
    return state;
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1000);
    await finishAuthAttempt(env, message).catch(() => {});
    throw new Error(`Browser Run authentication failed: ${message}`);
  }
}

async function ensureSession(env) {
  const config = configFromEnv(env);
  const state = await readAuthState(env);
  if (needsRefresh(state, config)) {
    return refreshSession(env, state.authToken ? 'token-near-expiry' : 'initial-session');
  }
  return state;
}

function is401Error(error) {
  return /(?:session expired|API)\s*\(?401\)?|\b401\b/i.test(String(error?.message || error));
}

async function responseContains401(response) {
  if (response.status !== 500) return false;
  const text = await response.clone().text().catch(() => '');
  return /\b401\b|session expired/i.test(text);
}

function authorized(request, env) {
  const expected = String(env.RUN_SECRET || '').trim();
  return Boolean(expected) && request.headers.get('authorization') === `Bearer ${expected}`;
}

async function authHealth(env) {
  const state = await readAuthState(env);
  return {
    browser_binding: Boolean(env.BROWSER),
    browser_session_ready: Boolean(state.authToken && state.deviceUid),
    browser_token_expires_at: state.tokenExpiresAt || null,
    browser_last_auth_attempt_at: state.lastAttemptAt || null,
    browser_last_auth_success_at: state.lastSuccessAt || null,
    browser_last_auth_error: state.lastError || null,
  };
}

export default {
  async scheduled(controller, env, ctx) {
    await ensureSession(env);
    try {
      return await collector.scheduled(controller, env, ctx);
    } catch (error) {
      if (!is401Error(error)) throw error;
      await refreshSession(env, 'api-401');
      return collector.scheduled(controller, env, ctx);
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/refresh-auth') {
      if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
      try {
        const state = await refreshSession(env, 'manual-refresh', { ignoreBackoff: true });
        return json({
          ok: true,
          token_expires_at: state.tokenExpiresAt || null,
          refreshed_at: state.lastSuccessAt || null,
        });
      } catch (error) {
        return json({ ok: false, error: error?.message || String(error) }, 500);
      }
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      const baseResponse = await collector.fetch(request, env, ctx);
      const base = await baseResponse.json().catch(() => ({}));
      return json({ ...base, ...(await authHealth(env)) }, baseResponse.status);
    }

    if (request.method === 'POST' && url.pathname === '/run') {
      if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
      await ensureSession(env);
      const retryRequest = request.clone();
      let response = await collector.fetch(request, env, ctx);
      if (await responseContains401(response)) {
        await refreshSession(env, 'api-401');
        response = await collector.fetch(retryRequest, env, ctx);
      }
      return response;
    }

    return collector.fetch(request, env, ctx);
  },
};
