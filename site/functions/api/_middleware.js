const inFlight = new Map();

function cachePolicy(url) {
  if (url.pathname === '/api/dashboard') return { ttl: 60, browser: 30 };
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
  if (request.method !== 'GET' || request.headers.has('authorization')) return context.next();

  const url = new URL(request.url);
  const policy = cachePolicy(url);
  if (!policy) return context.next();

  const cache = caches.default;
  const cacheKey = canonicalRequest(request);
  const hit = await cache.match(cacheKey);
  if (hit) return tagged(hit, 'HIT');

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
  return tagged(response, coalesced ? 'COALESCED' : 'MISS');
}
