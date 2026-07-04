const UPSTREAM_URL = 'https://production1.stationhead.com/weeklyLeaderboard';
const APP_VERSION = '2026.03.27.4';
const TIMEOUT_MS = 15000;
const SENSITIVE_RESPONSE_HEADERS = new Set([
  'authorization',
  'cookie',
  'developer-token',
  'pusher',
  'set-cookie',
]);

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-content-type-options': 'nosniff',
    },
  });
}

function normalizeBearer(value) {
  return String(value || '').trim().replace(/^Bearer\s+/i, '').trim();
}

async function loadSession(env = {}) {
  let row = null;
  if (env.DB?.prepare) {
    row = await env.DB.prepare(`
      SELECT auth_token, device_uid
      FROM sh_worker_collector_state
      WHERE id = 'stationhead'
    `).first();
  }

  const authToken = normalizeBearer(row?.auth_token || env.STATIONHEAD_AUTH_TOKEN);
  const deviceUid = String(row?.device_uid || env.STATIONHEAD_DEVICE_UID || '').trim();
  if (!authToken || !deviceUid) {
    throw new Error('Stationhead authenticated session is unavailable. Sync the collector session first.');
  }

  return {
    authToken,
    deviceUid,
    source: row?.auth_token && row?.device_uid ? 'd1' : 'environment',
  };
}

function visibleResponseHeaders(headers) {
  const result = {};
  for (const [name, value] of headers.entries()) {
    const lowerName = name.toLowerCase();
    if (lowerName === 'set-cookie' || lowerName === 'cookie') continue;
    result[name] = SENSITIVE_RESPONSE_HEADERS.has(lowerName) ? '[redacted]' : value;
  }
  return result;
}

function visibleRequestHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => {
    const lowerName = name.toLowerCase();
    if (lowerName === 'authorization') return [name, 'Bearer [redacted]'];
    if (lowerName === 'sth-device-uid') return [name, '[redacted]'];
    return [name, value];
  }));
}

export async function onRequestGet({ env = {} } = {}) {
  const startedAt = Date.now();
  let session;
  try {
    session = await loadSession(env);
  } catch (error) {
    return jsonResponse({
      ok: false,
      fetchedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      error: {
        type: 'configuration',
        message: String(error?.message || error),
      },
    }, 503);
  }

  const requestHeaders = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    Authorization: `Bearer ${session.authToken}`,
    'App-Version': env.STATIONHEAD_APP_VERSION || APP_VERSION,
    'App-Platform': 'android',
    Service: 'Spotify',
    Origin: 'https://www.stationhead.com',
    Referer: 'https://www.stationhead.com/',
    'sth-device-uid': session.deviceUid,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('upstream timeout'), TIMEOUT_MS);

  try {
    const upstream = await fetch(UPSTREAM_URL, {
      method: 'GET',
      headers: requestHeaders,
      redirect: 'manual',
      signal: controller.signal,
    });
    const bodyText = await upstream.text();
    const bodyBytes = new TextEncoder().encode(bodyText).byteLength;

    return jsonResponse({
      ok: upstream.ok,
      fetchedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      authentication: {
        source: session.source,
        bearerTokenPresent: true,
        deviceUidPresent: true,
      },
      request: {
        method: 'GET',
        url: UPSTREAM_URL,
        headers: visibleRequestHeaders(requestHeaders),
      },
      response: {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: visibleResponseHeaders(upstream.headers),
        bodyBytes,
        bodyText,
      },
    }, upstream.ok ? 200 : 502);
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return jsonResponse({
      ok: false,
      fetchedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      authentication: {
        source: session.source,
        bearerTokenPresent: true,
        deviceUidPresent: true,
      },
      request: {
        method: 'GET',
        url: UPSTREAM_URL,
        headers: visibleRequestHeaders(requestHeaders),
      },
      error: {
        type: timedOut ? 'timeout' : 'network',
        name: error?.name || 'Error',
        message: timedOut ? `Stationhead API did not respond within ${TIMEOUT_MS} ms.` : String(error?.message || error),
      },
    }, timedOut ? 504 : 502);
  } finally {
    clearTimeout(timeout);
  }
}
