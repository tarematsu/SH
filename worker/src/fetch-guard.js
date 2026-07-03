const BLOCKED_HOSTS = new Set([
  'itunes.apple.com',
]);
const OPTIONAL_HOSTS = new Set([
  'open.spotify.com',
]);
const OPTIONAL_TIMEOUT_MS = 5_000;
const OPTIONAL_FAILURE_BACKOFF_MS = 5 * 60_000;
const MAX_TRACKED_REQUESTS = 64;
const INSTALL_MARK = Symbol.for('stationhead-monitor.optional-fetch-guard');

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input?.url || '';
}

function requestMethod(input, init) {
  return String(init?.method || input?.method || 'GET').toUpperCase();
}

function blockedResponse(hostname) {
  return new Response('', {
    status: 410,
    headers: {
      'cache-control': 'no-store',
      'x-stationhead-fetch-guard': `blocked:${hostname}`,
    },
  });
}

function failureResponse(hostname) {
  return new Response('', {
    status: 503,
    headers: {
      'retry-after': String(Math.ceil(OPTIONAL_FAILURE_BACKOFF_MS / 1000)),
      'x-stationhead-fetch-guard': `backoff:${hostname}`,
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

export function createOptionalFetchGuard(nativeFetch, nowFn = Date.now) {
  if (typeof nativeFetch !== 'function') throw new TypeError('nativeFetch must be a function');

  const flights = new Map();
  const failures = new Map();

  const guardedFetch = async (input, init = {}) => {
    const rawUrl = requestUrl(input);
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return nativeFetch(input, init);
    }

    if (BLOCKED_HOSTS.has(url.hostname)) return blockedResponse(url.hostname);
    if (!OPTIONAL_HOSTS.has(url.hostname)) return nativeFetch(input, init);

    const method = requestMethod(input, init);
    const dedupe = method === 'GET' || method === 'HEAD';
    const key = `${method}\n${url.toString()}`;
    const now = Number(nowFn()) || Date.now();
    const retryAt = Number(failures.get(key) || 0);

    if (retryAt > now) return failureResponse(url.hostname);
    if (retryAt) failures.delete(key);

    if (dedupe && flights.has(key)) return (await flights.get(key)).clone();

    const requestInit = {
      ...init,
      signal: combinedSignal(init?.signal, OPTIONAL_TIMEOUT_MS),
    };
    const pending = Promise.resolve()
      .then(() => nativeFetch(input, requestInit))
      .then((response) => {
        if (response?.ok) failures.delete(key);
        else {
          failures.set(key, (Number(nowFn()) || Date.now()) + OPTIONAL_FAILURE_BACKOFF_MS);
          trimMap(failures);
        }
        return response;
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
    return (await pending).clone();
  };

  Object.defineProperty(guardedFetch, INSTALL_MARK, { value: true });
  return guardedFetch;
}

if (typeof globalThis.fetch === 'function' && !globalThis.fetch[INSTALL_MARK]) {
  globalThis.fetch = createOptionalFetchGuard(globalThis.fetch.bind(globalThis));
}
