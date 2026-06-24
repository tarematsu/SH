import puppeteer from '@cloudflare/puppeteer';
import collector from './index.js';

const API_ORIGIN = 'https://production1.stationhead.com';
const STATE_ID = 'stationhead';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

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
    return Number(JSON.parse(atob(padded)).exp || 0) * 1000;
  } catch {
    return 0;
  }
}

function positive(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function config(env) {
  return {
    alias: env.CHANNEL_ALIAS || 'buddies',
    timeoutMs: Math.min(positive(env.BROWSER_TIMEOUT_MS, 50_000), 55_000),
    refreshBeforeMs: positive(env.AUTH_REFRESH_BEFORE_MS, 3_600_000),
    cooldownMs: positive(env.AUTH_REFRESH_COOLDOWN_MS, 300_000),
    backoffMs: positive(env.AUTH_FAILURE_BACKOFF_MS, 900_000),
    lockMs: positive(env.AUTH_LOCK_MS, 90_000),
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

async function readState(env) {
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

async function claimLock(env, cfg) {
  const now = Date.now();
  const result = await env.DB.prepare(`
    UPDATE sh_worker_auth_control
    SET lock_until = ?, last_attempt_at = ?, updated_at = ?
    WHERE id = ? AND COALESCE(lock_until, 0) < ?
  `).bind(now + cfg.lockMs, now, now, STATE_ID, now).run();
  return Number(result?.meta?.changes || 0) > 0;
}

async function waitForRefresh(env, previousSuccessAt, cfg) {
  const deadline = Date.now() + Math.min(cfg.lockMs, 45_000);
  while (Date.now() < deadline) {
    await sleep(2_000);
    const state = await readState(env);
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

async function finishAttempt(env, error = null) {
  const now = Date.now();
  await env.DB.prepare(`
    UPDATE sh_worker_auth_control
    SET last_success_at = CASE WHEN ? IS NULL THEN ? ELSE last_success_at END,
        last_error = ?, lock_until = 0, updated_at = ?
    WHERE id = ?
  `).bind(error, now, error, now, STATE_ID).run();
}

function lowerCaseHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

async function captureGuestSession(env, cfg) {
  if (!env.BROWSER) throw new Error('Browser Run binding BROWSER is missing');

  let browser;
  let timer;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({ 'accept-language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7' });
    page.setDefaultNavigationTimeout(cfg.timeoutMs);
    page.setDefaultTimeout(cfg.timeoutMs);

    let authToken = '';
    let deviceUid = '';
    let settled = false;

    const credentials = new Promise((resolve, reject) => {
      const complete = () => {
        if (settled || !authToken || !deviceUid) return;
        settled = true;
        clearTimeout(timer);
        resolve({ authToken, deviceUid });
      };

      const inspect = (headers) => {
        const normalized = lowerCaseHeaders(headers);
        const token = normalizeBearer(normalized.authorization);
        const uid = String(normalized['sth-device-uid'] || '').trim();
        if (token) authToken = token;
        if (uid) deviceUid = uid;
        complete();
      };

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Timed out waiting for Stationhead guest credentials (token=${Boolean(authToken)}, device=${Boolean(deviceUid)})`));
      }, cfg.timeoutMs);

      page.on('request', (request) => {
        try {
          if (new URL(request.url()).origin === API_ORIGIN) inspect(request.headers());
        } catch {}
      });

      page.on('response', (response) => {
        try {
          if (new URL(response.url()).origin !== API_ORIGIN) return;
          inspect(response.request().headers());
          inspect(response.headers());
        } catch {}
      });

      page.createCDPSession().then(async (client) => {
        await client.send('Network.enable');
        client.on('Network.requestWillBeSentExtraInfo', (event) => inspect(event.headers));
        client.on('Network.responseReceivedExtraInfo', (event) => inspect(event.headers));
      }).catch(() => {});
    });

    const navigation = page.goto(`https://www.stationhead.com/c/${encodeURIComponent(cfg.alias)}`, {
      waitUntil: 'domcontentloaded',
      timeout: cfg.timeoutMs,
    }).catch((error) => {
      if (!settled) throw error;
      return null;
    });

    const result = await credentials;
    await navigation.catch(() => {});
    return result;
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
  }
}

async function refreshSession(env, reason, force = false) {
  const cfg = config(env);
  const initial = await readState(env);
  const now = Date.now();

  if (!force && initial.lastError && initial.lastAttemptAt && now - initial.lastAttemptAt < cfg.backoffMs) {
    return null;
  }

  if (!await claimLock(env, cfg)) {
    return waitForRefresh(env, initial.lastSuccessAt, cfg);
  }

  try {
    const credentials = await captureGuestSession(env, cfg);
    await saveSession(env, credentials.authToken, credentials.deviceUid);
    await finishAttempt(env, null);
    const state = await readState(env);
    console.log(JSON.stringify({
      event: 'stationhead_auth_refreshed',
      reason,
      token_expires_at: state.tokenExpiresAt || null,
    }));
    return state;
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1000);
    await finishAttempt(env, message).catch(() => {});
    throw new Error(`Browser Run authentication failed: ${message}`);
  }
}

async function ensureSession(env) {
  const cfg = config(env);
  const state = await readState(env);
  const ready = state.authToken && state.deviceUid;
  const expiresSoon = state.tokenExpiresAt && state.tokenExpiresAt - Date.now() <= cfg.refreshBeforeMs;

  if (ready && !expiresSoon) return true;
  if (ready && state.lastSuccessAt && Date.now() - state.lastSuccessAt < cfg.cooldownMs) return true;

  const refreshed = await refreshSession(env, ready ? 'token-near-expiry' : 'initial-session');
  return Boolean(refreshed?.authToken && refreshed?.deviceUid);
}

function is401(value) {
  return /\b401\b|session expired/i.test(String(value?.message || value));
}

function authorized(request, env) {
  const expected = String(env.RUN_SECRET || '').trim();
  return Boolean(expected) && request.headers.get('authorization') === `Bearer ${expected}`;
}

async function authHealth(env) {
  const state = await readState(env);
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
    try {
      if (!await ensureSession(env)) {
        console.warn(JSON.stringify({ event: 'stationhead_auth_backoff' }));
        return;
      }
      try {
        await collector.scheduled(controller, env, ctx);
      } catch (error) {
        if (!is401(error)) throw error;
        await refreshSession(env, 'api-401', true);
        await collector.scheduled(controller, env, ctx);
      }
    } catch (error) {
      console.error(error);
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/refresh-auth') {
      if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
      try {
        const state = await refreshSession(env, 'manual-refresh', true);
        return json({ ok: Boolean(state), token_expires_at: state?.tokenExpiresAt || null });
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
      try {
        if (!await ensureSession(env)) return json({ ok: false, error: 'authentication backoff' }, 503);
        let response = await collector.fetch(request, env, ctx);
        if (response.status === 500 && is401(await response.clone().text().catch(() => ''))) {
          await refreshSession(env, 'api-401', true);
          response = await collector.fetch(request, env, ctx);
        }
        return response;
      } catch (error) {
        return json({ ok: false, error: error?.message || String(error) }, 500);
      }
    }

    return collector.fetch(request, env, ctx);
  },
};
