const ORIGIN = 'https://production1.stationhead.com';
const OFFICIAL_IDLE_PATH = '/station/handle/sakurazaka46jp/guest';
const MAX_REQUESTS_PER_MINUTE = 10;
const MAX_STATION_REQUESTS_PER_MINUTE = 2;
const MAX_AUTH_REQUESTS_PER_MINUTE = 2;
const MAX_CHAT_ITEMS = 50;
const REQUEST_TIMEOUT_MS = 8_000;
const FAILURE_BACKOFF_MS = 60_000;
const MAX_ENTRIES = 64;

function trim(map) {
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
}

function methodOf(input, init) {
  return String(init?.method || input?.method || 'GET').toUpperCase();
}

function bodyOf(input, init) {
  if (init?.body == null) return input instanceof Request ? null : '';
  return typeof init.body === 'string' ? init.body.trim() : null;
}

function headersOf(input, init) {
  return new Headers(init?.headers || input?.headers || undefined);
}

function policy(url, method, body) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (method === 'GET' && /^\/channels\/alias\/[^/]+$/i.test(path)) {
    return { cache: true, name: 'channel', budget: 'data' };
  }
  if (method === 'GET' && /^\/station\/[^/]+\/chatHistory$/i.test(path)) {
    const limit = Math.max(1, Number(url.searchParams.get('limit')) || MAX_CHAT_ITEMS);
    url.searchParams.set('limit', String(Math.min(limit, MAX_CHAT_ITEMS)));
    return { cache: true, name: 'chat', budget: 'data' };
  }
  if (method === 'POST' && /^\/station\/handle\/[^/]+\/guest$/i.test(path)) {
    if (body !== '' && body !== '{}') return null;
    return {
      cache: true,
      name: 'station',
      budget: 'station',
      idleNotFound: path.toLowerCase() === OFFICIAL_IDLE_PATH,
    };
  }
  if (method === 'GET' && path === '/account' && url.searchParams.has('ids')) {
    return { cache: true, name: 'account', budget: 'data' };
  }
  if (method === 'POST' && path === '/web/token' && body === '') {
    return { cache: false, name: 'token', budget: 'auth' };
  }
  if (method === 'POST' && path === '/web/guest/login' && body === '') {
    return { cache: false, name: 'login', budget: 'auth' };
  }
  return null;
}

function localResponse(status, reason, retryAfter = 0) {
  const headers = { 'cache-control': 'no-store', 'x-sh-traffic-guard': reason };
  if (retryAfter > 0) headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfter / 1000)));
  return new Response('', { status, headers });
}

function signalWithTimeout(signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (!signal) return timeout;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal;
}

function retryable(status) {
  const code = Number(status);
  return code === 408 || code === 425 || code === 429 || code >= 500;
}

async function normalizeIdleGuestResponse(response, rule) {
  if (!rule?.idleNotFound || Number(response?.status) !== 404) return response;
  const body = await response.clone().text().catch(() => '');
  let payload = null;
  try {
    payload = body ? JSON.parse(body) : null;
  } catch {
    return response;
  }
  const error = payload?.error || {};
  if (String(error.code || '') !== '1001' || !/not in database/i.test(String(error.detail || ''))) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-sh-broadcast-state', 'idle');
  return new Response('{}', { status: 200, headers });
}

async function responseSnapshot(response) {
  return {
    status: Number(response?.status || 0),
    statusText: String(response?.statusText || ''),
    headers: [...new Headers(response?.headers || undefined).entries()],
    body: await response.arrayBuffer(),
  };
}

function responseFromSnapshot(snapshot) {
  return new Response(snapshot.body.slice(0), {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: snapshot.headers,
  });
}

function requestBudget(rule) {
  if (rule.budget === 'auth') return MAX_AUTH_REQUESTS_PER_MINUTE;
  if (rule.budget === 'station') return MAX_STATION_REQUESTS_PER_MINUTE;
  return MAX_REQUESTS_PER_MINUTE;
}

function budgetReason(rule) {
  if (rule.budget === 'auth') return 'auth-minute-budget-exhausted';
  if (rule.budget === 'station') return 'station-minute-budget-exhausted';
  return 'minute-budget-exhausted';
}

export function createShTrafficGuard(nextFetch, nowFn = Date.now) {
  if (typeof nextFetch !== 'function') throw new TypeError('nextFetch must be a function');

  // Only detached byte snapshots are cached. Response, Request, streams and
  // in-flight fetch promises are scoped to one Cloudflare request context and
  // must never survive into a later cron execution.
  const reads = new Map();
  const retryAtByKey = new Map();
  let activeMinute = -1;
  let dataRequestCount = 0;
  let stationRequestCount = 0;
  let authRequestCount = 0;

  return async function shTrafficGuard(input, init = {}) {
    let url;
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input?.url;
      url = new URL(raw);
    } catch {
      return nextFetch(input, init);
    }
    if (url.origin !== ORIGIN) return nextFetch(input, init);

    const method = methodOf(input, init);
    const body = bodyOf(input, init);
    const rule = policy(url, method, body);
    if (!rule) {
      console.warn(JSON.stringify({ event: 'sh_route_rejected', method, path: url.pathname }));
      return localResponse(405, 'route-not-allowed');
    }

    const now = Number(nowFn()) || Date.now();
    const minute = Math.floor(now / 60_000);
    if (minute !== activeMinute) {
      activeMinute = minute;
      dataRequestCount = 0;
      stationRequestCount = 0;
      authRequestCount = 0;
      reads.clear();
    }

    const headers = headersOf(input, init);
    const key = [
      method,
      url.toString(),
      body || '',
      headers.get('sth-device-uid') || '',
      headers.get('authorization') || '',
    ].join('\n');
    const retryAt = Number(retryAtByKey.get(key) || 0);
    if (retryAt > now) return localResponse(503, 'temporary-backoff', retryAt - now);
    if (retryAt) retryAtByKey.delete(key);

    const cached = rule.cache ? reads.get(key) : null;
    if (cached) return responseFromSnapshot(cached);

    const requestLimit = requestBudget(rule);
    const requestCount = rule.budget === 'auth'
      ? authRequestCount
      : rule.budget === 'station' ? stationRequestCount : dataRequestCount;
    if (requestCount >= requestLimit) {
      const wait = 60_000 - (now % 60_000);
      const reason = budgetReason(rule);
      console.warn(JSON.stringify({
        event: 'sh_request_budget_exhausted',
        budget: rule.budget,
        limit: requestLimit,
        route: rule.name,
      }));
      return localResponse(429, reason, wait);
    }
    if (rule.budget === 'auth') authRequestCount += 1;
    else if (rule.budget === 'station') stationRequestCount += 1;
    else dataRequestCount += 1;

    const requestInput = input instanceof Request ? new Request(url.toString(), input) : url.toString();
    try {
      const response = await nextFetch(requestInput, { ...init, signal: signalWithTimeout(init?.signal) });
      const normalized = await normalizeIdleGuestResponse(response, rule);
      const snapshot = await responseSnapshot(normalized);
      if (retryable(snapshot.status)) {
        retryAtByKey.set(key, (Number(nowFn()) || Date.now()) + FAILURE_BACKOFF_MS);
        trim(retryAtByKey);
        reads.delete(key);
      } else if (snapshot.status < 200 || snapshot.status >= 300) {
        reads.delete(key);
      } else {
        retryAtByKey.delete(key);
        if (rule.cache) {
          reads.set(key, snapshot);
          trim(reads);
        }
      }
      return responseFromSnapshot(snapshot);
    } catch (error) {
      retryAtByKey.set(key, (Number(nowFn()) || Date.now()) + FAILURE_BACKOFF_MS);
      trim(retryAtByKey);
      reads.delete(key);
      throw error;
    }
  };
}
