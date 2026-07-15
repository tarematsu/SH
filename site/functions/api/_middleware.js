import {
  API_SUCCESSORS,
  BLOCKED_API_PATHS,
} from '../lib/api-contract.js';

const inFlight = new Map();
const blockedApiPaths = new Set(BLOCKED_API_PATHS);

function normalizedPathname(value) {
  const pathname = String(value || '/');
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

export function isBlockedApiPath(pathname) {
  return blockedApiPaths.has(normalizedPathname(pathname));
}

export function apiSuccessor(pathname) {
  return API_SUCCESSORS[normalizedPathname(pathname)] || null;
}

function notFoundResponse() {
  return Response.json({ ok: false, error: 'not found' }, {
    status: 404,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function compatibilityResponse(response, successor) {
  if (!successor) return response;
  const headers = new Headers(response.headers);
  headers.set('deprecation', 'true');
  headers.set('link', `<${successor}>; rel="successor-version"`);
  headers.set('x-api-successor', successor);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function cachePolicy(url) {
  if (url.pathname === '/api/dashboard') return { ttl: 60, browser: 30 };
  if (url.pathname === '/api/dashboard-history') return { ttl: 300, browser: 60 };
  if (url.pathname === '/api/history-current' || url.pathname === '/api/minute-facts/current') {
    return { ttl: 60, browser: 30 };
  }
  if (url.pathname === '/api/track-history') return { ttl: 900, browser: 300 };
  if (url.pathname === '/api/like-ranking') return { ttl: 900, browser: 300 };
  if (url.pathname === '/api/broadcast-series') return { ttl: 3600, browser: 300 };
  if (url.pathname === '/api/history') {
    const mode = url.searchParams.get('mode') || 'weekly';
    if (mode === 'raw' || url.searchParams.has('cursor')) return null;
    if (mode === 'broadcasts') return { ttl: 900, browser: 120 };
    return { ttl: 300, browser: 60 };
  }
  return null;
}

function canonicalRequest(request) {
  const url = new URL(request.url);
  url.searchParams.delete('v');
  const sorted = [...url.searchParams.entries()].sort(([aKey, aValue], [bKey, bValue]) =>
    aKey.localeCompare(bKey) || aValue.localeCompare(bValue));
  url.search = '';
  for (const [key, value] of sorted) url.searchParams.append(key, value);
  return new Request(url.toString(), {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
}

function tagged(response, state) {
  const clone = response.clone();
  const headers = new Headers(clone.headers);
  headers.set('x-edge-cache', state);
  return new Response(clone.body, {
    status: clone.status,
    statusText: clone.statusText,
    headers,
  });
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  if (isBlockedApiPath(url.pathname)) return notFoundResponse();

  const successor = apiSuccessor(url.pathname);
  if (request.method !== 'GET' || request.headers.has('authorization')) {
    return compatibilityResponse(await context.next(), successor);
  }

  const policy = cachePolicy(url);
  if (!policy) return compatibilityResponse(await context.next(), successor);

  const cache = caches.default;
  const cacheKey = canonicalRequest(request);
  const hit = await cache.match(cacheKey);
  if (hit) return compatibilityResponse(tagged(hit, 'HIT'), successor);

  const key = cacheKey.url;
  let task = inFlight.get(key);
  const coalesced = Boolean(task);

  if (!task) {
    task = (async () => {
      const origin = await context.next();
      const headers = new Headers(origin.headers);
      if (origin.ok) {
        headers.set('cache-control', `public, max-age=${policy.browser}, s-maxage=${policy.ttl}, stale-while-revalidate=${policy.ttl * 2}`);
      }
      headers.set('vary', 'accept-encoding');
      const shared = new Response(origin.body, {
        status: origin.status,
        statusText: origin.statusText,
        headers,
      });
      if (shared.ok) context.waitUntil(cache.put(cacheKey, shared.clone()));
      return shared;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, task);
  }

  const response = await task;
  return compatibilityResponse(tagged(response, coalesced ? 'COALESCED' : 'MISS'), successor);
}
