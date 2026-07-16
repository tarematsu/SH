const PLAYBACK_EDGE_TTL_SECONDS = 300;
const PLAYBACK_BROWSER_TTL_SECONDS = 30;
const inFlight = new Map();

function primaryPlaybackRequest(request) {
  if (request.method !== 'GET' || request.headers.has('authorization')) return false;
  const url = new URL(request.url);
  if (url.pathname !== '/api/playback' || url.searchParams.has('raw')) return false;
  const channel = String(url.searchParams.get('channel') || 'buddies').trim().toLowerCase();
  return channel === 'buddies';
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
  headers.set('x-playback-cache', state);
  return new Response(clone.body, {
    status: clone.status,
    statusText: clone.statusText,
    headers,
  });
}

export async function onRequest(context) {
  const { request } = context;
  if (!primaryPlaybackRequest(request)) return context.next();

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
        headers.set(
          'cache-control',
          `public, max-age=${PLAYBACK_BROWSER_TTL_SECONDS}, s-maxage=${PLAYBACK_EDGE_TTL_SECONDS}, stale-while-revalidate=${PLAYBACK_EDGE_TTL_SECONDS * 2}`,
        );
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

  return tagged(await task, coalesced ? 'COALESCED' : 'MISS');
}
