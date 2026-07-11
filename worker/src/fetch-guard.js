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

async function responseSnapshot(response) {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
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

function resendResponseFromSnapshot(snapshot, cacheStatus) {
  const headers = new Headers(snapshot.headers);
  headers.set('x-sh-resend-cache', cacheStatus);
  return new Response(snapshot.body.slice(0), {
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

  // Shared promises resolve only to detached status/header/body bytes. No
  // Response, Request or stream is retained in module scope.
  const flights = new Map();
  const failures = new Map();
  const resendFlights = new Map();
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

      const existing = resendFlights.get(successKey);
      if (existing) return resendResponseFromSnapshot(await existing, 'coalesced');

      const pending = Promise.resolve()
        .then(() => nativeFetch(input, init))
        .then(async (response) => {
          const snapshot = await responseSnapshot(response);
          if (responseOk(snapshot)) {
            resendSuccesses.set(successKey, {
              snapshot,
              expiresAt: (Number(nowFn()) || Date.now()) + RESEND_SUCCESS_TTL_MS,
            });
            trimMap(resendSuccesses);
          }
          return snapshot;
        })
        .finally(() => {
          if (resendFlights.get(successKey) === pending) resendFlights.delete(successKey);
        });
      resendFlights.set(successKey, pending);
      trimMap(resendFlights);
      return resendResponseFromSnapshot(await pending, 'miss');
    }

    if (!OPTIONAL_HOSTS.has(url.hostname)) return nativeFetch(input, init);

    const dedupe = method === 'GET' || method === 'HEAD';
    const key = `${method}\n${url.toString()}`;
    const retryAt = Number(failures.get(key) || 0);

    if (retryAt > now) return failureResponse(url.hostname);
    if (retryAt) failures.delete(key);

    const existing = dedupe ? flights.get(key) : null;
    if (existing) return responseFromSnapshot(await existing);

    const requestInit = {
      ...init,
      signal: combinedSignal(init?.signal, OPTIONAL_TIMEOUT_MS),
    };
    const pending = Promise.resolve()
      .then(() => nativeFetch(input, requestInit))
      .then(async (response) => {
        const snapshot = await responseSnapshot(response);
        if (responseOk(snapshot)) failures.delete(key);
        else {
          failures.set(key, (Number(nowFn()) || Date.now()) + OPTIONAL_FAILURE_BACKOFF_MS);
          trimMap(failures);
        }
        return snapshot;
      })
      .catch((error) => {
        failures.set(key, (Number(nowFn()) || Date.now()) + OPTIONAL_FAILURE_BACKOFF_MS);
        trimMap(failures);
        throw error;
      })
      .finally(() => {
        if (flights.get(key) === pending) flights.delete(key);
      });

    if (dedupe) {
      flights.set(key, pending);
      trimMap(flights);
    }
    return responseFromSnapshot(await pending);
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
