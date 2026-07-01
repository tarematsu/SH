const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 16;

function positive(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function requestParts(input, init = {}) {
  const request = input instanceof Request ? input : null;
  const method = String(init.method || request?.method || 'GET').toUpperCase();
  const rawUrl = request?.url || String(input || '');
  let url;
  try { url = new URL(rawUrl); } catch { return { method, url: null }; }
  return { method, url };
}

export function canonicalTrackLookupKey(input, init = {}) {
  const { method, url } = requestParts(input, init);
  if (method !== 'GET' || !url || url.searchParams.get('type') !== 'track_lookup') return null;
  const ids = [...new Set(
    (url.searchParams.get('ids') || '').split(',').map((value) => value.trim()).filter(Boolean),
  )].sort();
  url.searchParams.set('ids', ids.join(','));
  return url.toString();
}

function isTrackMetadataWrite(input, init = {}) {
  const { method } = requestParts(input, init);
  if (method !== 'POST' || typeof init.body !== 'string') return false;
  try { return JSON.parse(init.body)?.type === 'track_metadata'; } catch { return false; }
}

function snapshotResponse(response) {
  return response.arrayBuffer().then((body) => ({
    body,
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    ok: response.ok,
  }));
}

function responseFromSnapshot(snapshot) {
  return new Response(snapshot.body.slice(0), {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: snapshot.headers,
  });
}

export function createTrackLookupCachedFetch(nativeFetch, options = {}) {
  const ttlMs = positive(options.ttlMs, DEFAULT_TTL_MS);
  const maxEntries = positive(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const cache = new Map();

  const clear = () => cache.clear();

  async function cachedFetch(input, init = {}) {
    const key = canonicalTrackLookupKey(input, init);
    if (!key) {
      const response = await nativeFetch(input, init);
      if (response.ok && isTrackMetadataWrite(input, init)) clear();
      return response;
    }

    const now = Date.now();
    const cached = cache.get(key);
    if (cached?.snapshot && cached.expiresAt > now) {
      cache.delete(key);
      cache.set(key, cached);
      return responseFromSnapshot(cached.snapshot);
    }
    if (cached?.pending) return responseFromSnapshot(await cached.pending);

    const entry = cached || {};
    entry.pending = nativeFetch(input, init).then(snapshotResponse).then((snapshot) => {
      if (snapshot.ok) {
        entry.snapshot = snapshot;
        entry.expiresAt = Date.now() + ttlMs;
      } else {
        cache.delete(key);
      }
      return snapshot;
    }).catch((error) => {
      cache.delete(key);
      throw error;
    }).finally(() => {
      entry.pending = null;
    });
    cache.set(key, entry);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    return responseFromSnapshot(await entry.pending);
  }

  cachedFetch.clearTrackLookupCache = clear;
  cachedFetch.trackLookupCache = cache;
  return cachedFetch;
}

if (!globalThis.__stationheadTrackLookupCacheInstalled && typeof globalThis.fetch === 'function') {
  globalThis.fetch = createTrackLookupCachedFetch(globalThis.fetch.bind(globalThis), {
    ttlMs: positive(process.env.TRACK_LOOKUP_CACHE_MS, DEFAULT_TTL_MS),
    maxEntries: positive(process.env.TRACK_LOOKUP_CACHE_MAX, DEFAULT_MAX_ENTRIES),
  });
  globalThis.__stationheadTrackLookupCacheInstalled = true;
}
