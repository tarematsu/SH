import { createShTrafficGuard } from './sh-traffic-guard.js';

const BLOCKED_HOSTS = new Set([
  'itunes.apple.com',
]);
const OPTIONAL_HOSTS = new Set([
  'open.spotify.com',
]);
const RESEND_HOST = 'api.resend.com';
const RESEND_SUCCESS_TTL_MS = 60 * 60_000;
const OPTIONAL_TIMEOUT_MS = 5_000;
const OPTIONAL_FAILURE_BACKOFF_MS = 5 * 60_000;
const MAX_TRACKED_REQUESTS = 64;
const INSTALL_MARK = Symbol.for('sh-monitor.optional-fetch-guard');

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input?.url || '';
}

function requestMethod(input, init) {
  return String(init?.method || input?.method || 'GET').toUpperCase();
}

function requestHeaders(input, init) {
  return new Headers(init?.headers || input?.headers || undefined);
}

function blockedResponse(hostname) {
  return new Response('', {
    status: 410,
    headers: {
      'cache-control': 'no-store',
      'x-sh-fetch-guard': `blocked:${hostname}`,
    },
  });
}

function failureResponse(hostname) {
  return new Response('', {
    status: 503,
    headers: {
      'retry-after': String(Math.ceil(OPTIONAL_FAILURE_BACKOFF_MS / 1000)),
      'x-sh-fetch-guard': `backoff:${hostname}`,
    },
  });
}

function trimMap(map) {
  while (map.size > MAX_TRACKED_REQUESTS) map.delete(map.keys().next().value);
}

function combinedSignal(original, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!original) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([original, timeout]);
  return original;
}

function nullBodyStatus(status) {
  const code = Number(status);
  return code === 101 || code === 204 || code === 205 || code === 304;
}

async function responseSnapshot(response, method = 'GET') {
  const status = Number(response.status || 0);
  return {
    status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    body: method === 'HEAD' || nullBodyStatus(status) ? null : await response.arrayBuffer(),
  };
}

function responseFromSnapshot(snapshot) {
  return new Response(snapshot.body == null ? null : snapshot.body.slice(0), {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: snapshot.headers,
  });
}

function resendResponseFromSnapshot(snapshot, cacheStatus) {
  const headers = new Headers(snapshot.headers);
  headers.set('x-sh-resend-cache', cacheStatus);
  return new Response(snapshot.body == null ? null : snapshot.body.slice(0), {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers,
  });
}

function responseOk(snapshot) {
  return snapshot.status >= 200 && snapshot.status < 300;
}

export function createOptionalFetchGuard(nativeFetch, nowFn = Date.now) {
  if (typeof nativeFetch !== 'function') throw new TypeError('nativeFetch must be a function');

  // Only settled timestamps and detached response bytes survive between Worker
  // invocations. In-flight Promises may still be awaiting request-scoped fetch
  // or body I/O, so concurrent misses deliberately remain request-local.
  const failures = new Map();
  const resendSuccesses = new Map();

  const guardedFetch = async (input, init = {}) => {
    const rawUrl = requestUrl(input);
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return nativeFetch(input, init);
    }

    if (BLOCKED_HOSTS.has(url.hostname)) return blockedResponse(url.hostname);

    const method = requestMethod(input, init);
    const now = Number(nowFn()) || Date.now();

    if (url.hostname === RESEND_HOST && method === 'POST') {
      const idempotencyKey = requestHeaders(input, init).get('idempotency-key')?.trim();
      if (!idempotencyKey) return nativeFetch(input, init);

      const successKey = `${url.toString()}\n${idempotencyKey}`;
      const cached = resendSuccesses.get(successKey);
      if (cached && cached.expiresAt > now) {
        return resendResponseFromSnapshot(cached.snapshot, 'hit');
      }
      if (cached) resendSuccesses.delete(successKey);

      // Concurrent sends retain the same provider idempotency key but never share
      // a Promise tied to another Worker invocation.
      const response = await nativeFetch(input, init);
      const snapshot = await responseSnapshot(response, method);
      if (responseOk(snapshot)) {
        resendSuccesses.set(successKey, {
          snapshot,
          expiresAt: (Number(nowFn()) || Date.now()) + RESEND_SUCCESS_TTL_MS,
        });
        trimMap(resendSuccesses);
      }
      return resendResponseFromSnapshot(snapshot, 'miss');
    }

    if (!OPTIONAL_HOSTS.has(url.hostname)) return nativeFetch(input, init);

    const key = `${method}\n${url.toString()}`;
    const retryAt = Number(failures.get(key) || 0);

    if (retryAt > now) return failureResponse(url.hostname);
    if (retryAt) failures.delete(key);

    const requestInit = {
      ...init,
      signal: combinedSignal(init?.signal, OPTIONAL_TIMEOUT_MS),
    };
    try {
      const response = await nativeFetch(input, requestInit);
      const snapshot = await responseSnapshot(response, method);
      if (responseOk(snapshot)) failures.delete(key);
      else {
        failures.set(key, (Number(nowFn()) || Date.now()) + OPTIONAL_FAILURE_BACKOFF_MS);
        trimMap(failures);
      }
      return responseFromSnapshot(snapshot);
    } catch (error) {
      failures.set(key, (Number(nowFn()) || Date.now()) + OPTIONAL_FAILURE_BACKOFF_MS);
      trimMap(failures);
      throw error;
    }
  };

  Object.defineProperty(guardedFetch, INSTALL_MARK, { value: true });
  return guardedFetch;
}

if (typeof globalThis.fetch === 'function' && !globalThis.fetch[INSTALL_MARK]) {
  const optionalGuard = createOptionalFetchGuard(globalThis.fetch.bind(globalThis));
  const shGuard = createShTrafficGuard(optionalGuard);
  Object.defineProperty(shGuard, INSTALL_MARK, { value: true });
  globalThis.fetch = shGuard;
}
