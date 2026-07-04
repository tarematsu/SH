const UPSTREAM_URL = 'https://production1.stationhead.com/weeklyLeaderboard';
const APP_VERSION = '2026.03.27.4';
const TIMEOUT_MS = 15000;

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

function visibleResponseHeaders(headers) {
  const result = {};
  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase() === 'set-cookie') continue;
    result[name] = value;
  }
  return result;
}

export async function onRequestGet() {
  const deviceUid = crypto.randomUUID();
  const requestHeaders = {
    Accept: 'application/json',
    'App-Version': APP_VERSION,
    'App-Platform': 'android',
    Service: 'Spotify',
    'sth-device-uid': deviceUid,
  };

  const startedAt = Date.now();
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
      request: {
        method: 'GET',
        url: UPSTREAM_URL,
        headers: requestHeaders,
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
      request: {
        method: 'GET',
        url: UPSTREAM_URL,
        headers: requestHeaders,
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
