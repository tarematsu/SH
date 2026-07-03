const ORIGIN = 'https://production1.stationhead.com';
const MAX_REQUESTS_PER_MINUTE = 10;
const MAX_CHAT_ITEMS = 20;
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

function policy(url, method, body) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (method === 'GET' && /^\/channels\/alias\/[^/]+$/i.test(path)) return { cache: true, name: 'channel' };
  if (method === 'GET' && /^\/station\/[^/]+\/chatHistory$/i.test(path)) {
    const limit = Math.max(1, Number(url.searchParams.get('limit')) || MAX_CHAT_ITEMS);
    url.searchParams.set('limit', String(Math.min(limit, MAX_CHAT_ITEMS)));
    return { cache: true, name: 'chat' };
  }
  if (method === 'POST' && /^\/station\/handle\/[^/]+\/guest$/i.test(path)) {
    if (body !== '' && body !== '{}') return null;
    return { cache: true, name: 'station' };
  }
  if (method === 'GET' && path === '/account' && url.searchParams.has('ids')) return { cache: true, name: 'account' };
  if (method === 'POST' && path === '/web/token' && body === '') return { cache: false, name: 'token' };
  if (method === 'POST' && path === '/web/guest/login' && body === '') return { cache: false, name: 'login' };
  return null;
}

function localResponse(status, reason, retryAfter = 0) {
  const headers = { 'cache-control': 'no-store', 'x-stationhead-traffic-guard': reason };
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

export function createStationheadTrafficGuard(nextFetch, nowFn = Date.now) {
  if (typeof nextFetch !== 'function') throw new TypeError('nextFetch must be a function');

  const reads = new Map();
  const retryAtByKey = new Map();
  let activeMinute = -1;
  let requestCount = 0;

  return async function stationheadTrafficGuard(input, init = {}) {
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
      console.warn(JSON.stringify({ event: 'stationhead_route_rejected', method, path: url.pathname }));
      return localResponse(405, 'route-not-allowed');
    }

    const now = Number(nowFn()) || Date.now();
    const minute = Math.floor(now / 60_000);
    if (minute !== activeMinute) {
      activeMinute = minute;
      requestCount = 0;
      reads.clear();
    }

    const key = `${method}\n${url.toString()}\n${body || ''}`;
    const retryAt = Number(retryAtByKey.get(key) || 0);
    if (retryAt > now) return localResponse(503, 'temporary-backoff', retryAt - now);
    if (retryAt) retryAtByKey.delete(key);

    if (rule.cache && reads.has(key)) return (await reads.get(key)).clone();
    if (requestCount >= MAX_REQUESTS_PER_MINUTE) {
      const wait = 60_000 - (now % 60_000);
      console.warn(JSON.stringify({ event: 'stationhead_request_budget_exhausted', limit: MAX_REQUESTS_PER_MINUTE, route: rule.name }));
      return localResponse(429, 'minute-budget-exhausted', wait);
    }
    requestCount += 1;

    const requestInput = input instanceof Request ? new Request(url.toString(), input) : url.toString();
    const pending = Promise.resolve()
      .then(() => nextFetch(requestInput, { ...init, signal: signalWithTimeout(init?.signal) }))
      .then((response) => {
        if (retryable(response?.status)) {
          retryAtByKey.set(key, (Number(nowFn()) || Date.now()) + FAILURE_BACKOFF_MS);
          trim(retryAtByKey);
          reads.delete(key);
        } else if (!response?.ok) {
          reads.delete(key);
        } else {
          retryAtByKey.delete(key);
        }
        return response;
      })
      .catch((error) => {
        retryAtByKey.set(key, (Number(nowFn()) || Date.now()) + FAILURE_BACKOFF_MS);
        trim(retryAtByKey);
        reads.delete(key);
        throw error;
      });

    if (rule.cache) {
      reads.set(key, pending);
      trim(reads);
    }
    return (await pending).clone();
  };
}
