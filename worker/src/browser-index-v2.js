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
    appVersion: env.STATIONHEAD_APP_VERSION || '1.0.0',
    requestTimeoutMs: Math.min(positive(env.REQUEST_TIMEOUT_MS, 15_000), 30_000),
    browserTimeoutMs: Math.min(positive(env.BROWSER_TIMEOUT_MS, 50_000), 55_000),
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

function apiHeaders(cfg, deviceUid, authToken = '') {
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

async function apiFetch(cfg, path, options = {}) {
  return fetch(`${API_ORIGIN}${path}`, {
    ...options,
    signal: AbortSignal.timeout(cfg.requestTimeoutMs),
  });
}

async function acquireDirectSession(cfg) {
  const deviceUid = crypto.randomUUID();
  const unauthenticatedHeaders = apiHeaders(cfg, deviceUid);

  await apiFetch(cfg, '/timestamp', {
    headers: unauthenticatedHeaders,
  }).catch(() => null);

  const tokenResponse = await apiFetch(cfg, '/web/token', {
    method: 'POST',
    headers: unauthenticatedHeaders,
    body: '',
  });
  const authToken = normalizeBearer(tokenResponse.headers.get('authorization'));
  if (!tokenResponse.ok || !authToken) {
    const body = await tokenResponse.text().catch(() => '');
    throw new Error(`Direct guest token failed: status=${tokenResponse.status}, authorization=${Boolean(authToken)}${body ? `, body=${body.slice(0, 200)}` : ''}`);
  }

  const authenticatedHeaders = apiHeaders(cfg, deviceUid, authToken);
  const loginResponse = await apiFetch(cfg, '/web/guest/login', {
    method: 'POST',
    headers: authenticatedHeaders,
    body: '',
  });
  if (!loginResponse.ok) {
    const body = await loginResponse.text().catch(() => '');
    throw new Error(`Direct guest login failed: status=${loginResponse.status}${body ? `, body=${body.slice(0, 200)}` : ''}`);
  }

  const verifyResponse = await apiFetch(cfg, `/channels/alias/${encodeURIComponent(cfg.alias)}`, {
    headers: authenticatedHeaders,
  });
  if (!verifyResponse.ok) {
    const body = await verifyResponse.text().catch(() => '');
    throw new Error(`Direct guest verification failed: status=${verifyResponse.status}${body ? `, body=${body.slice(0, 200)}` : ''}`);
  }
  await verifyResponse.arrayBuffer().catch(() => {});

  return { authToken, deviceUid, method: 'direct-api' };
}

function lowerCaseHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

async function captureBrowserSession(env, cfg) {
  if (!env.BROWSER) throw new Error('Browser Run binding BROWSER is missing');

  let browser;
  let timer;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({ 'accept-language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7' });
    page.setDefaultNavigationTimeout(cfg.browserTimeoutMs);
    page.setDefaultTimeout(cfg.browserTimeoutMs);

    let authToken = '';
    let deviceUid = '';
    let settled = false;
    let apiRequests = 0;

    const credentials = new Promise((resolve, reject) => {
      const complete = () => {
        if (settled || !authToken || !deviceUid) return;
        settled = true;
        clearTimeout(timer);
        resolve({ authToken, deviceUid, method: 'browser-run' });
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
        reject(new Error(`Browser credentials timed out (token=${Boolean(authToken)}, device=${Boolean(deviceUid)}, api_requests=${apiRequests})`));
      }, cfg.browserTimeoutMs);

      page.on('request', (request) => {
        try {
          if (new URL(request.url()).origin === API_ORIGIN) {
            apiRequests += 1;
            inspect(request.headers());
          }
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

    await page.goto(`https://www.stationhead.com/c/${encodeURIComponent(cfg.alias)}`, {
      waitUntil: 'domcontentloaded',
      timeout: cfg.browserTimeoutMs,
    });

    await sleep(3_000);
    await page.evaluate(() => {
      const candidates = [...document.querySelectorAll('button, [role="button"], a')];
      const target = candidates.find((element) => /start listening|listen|join|play|再生|聴く/i.test(element.textContent || ''));
      target?.click();
    }).catch(() => {});

    return await credentials;
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
  }
}

async function acquireSession(env, cfg) {
  try {
    return await acquireDirectSession(cfg);
  } catch (directError) {
    console.warn(JSON.stringify({
      event: 'stationhead_direct_auth_failed',
      error: String(directError?.message || directError).slice(0, 500),
    }));
    try {
      return await captureBrowserSession(env, cfg);
    } catch (browserError) {
      throw new Error(`Direct auth: ${directError?.message || directError}; Browser fallback: ${browserError?.message || browserError}`);
    }
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
    const credentials = await acquireSession(env, cfg);
    await saveSession(env, credentials.authToken, credentials.deviceUid);
    await finishAttempt(env, null);
    const state = await readState(env);
    console.log(JSON.stringify({
      event: 'stationhead_auth_refreshed',
      method: credentials.method,
      reason,
      token_expires_at: state.tokenExpiresAt || null,
    }));
    return state;
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1000);
    await finishAttempt(env, message).catch(() => {});
    throw new Error(`Stationhead authentication failed: ${message}`);
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
