import {
  API_BROWSER_TTL_SECONDS,
  API_EDGE_TTL_SECONDS,
  MATERIALIZED_RESPONSE_MAX_AGE_MS,
  canonicalApiCacheRequest,
  edgeCacheableApiRequest,
  materializedApiKey,
} from './lib/api-contract.js';

const inFlight = new Map();

function tagged(response, cacheState) {
  const clone = response.clone();
  const headers = new Headers(clone.headers);
  headers.set('x-edge-cache', cacheState);
  return new Response(clone.body, {
    status: clone.status,
    statusText: clone.statusText,
    headers,
  });
}

function safeHeaders(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function materializedMaximumAge(env = {}) {
  const configured = Number(env.PAGES_RESPONSE_MAX_AGE_MS);
  if (!Number.isFinite(configured) || configured < API_EDGE_TTL_SECONDS * 1000) {
    return MATERIALIZED_RESPONSE_MAX_AGE_MS;
  }
  return configured;
}

async function materializedResponse(context, modelKey, now = Date.now()) {
  if (!modelKey || !context.env?.MINUTE_DB) return null;
  const db = context.env.MINUTE_DB;
  try {
    const manifest = await db.prepare(`SELECT generation,status,headers_json,chunk_count,updated_at
      FROM sh_pages_response_manifest
      WHERE model_key=?
      LIMIT 1`).bind(modelKey).first();
    if (!manifest?.generation || Number(manifest.chunk_count) <= 0) return null;
    if (now - Number(manifest.updated_at || 0) > materializedMaximumAge(context.env)) return null;

    const result = await db.prepare(`SELECT payload_chunk
      FROM sh_pages_response_chunks
      WHERE model_key=? AND generation=?
      ORDER BY chunk_index ASC`).bind(modelKey, manifest.generation).all();
    const rows = result.results || [];
    if (rows.length !== Number(manifest.chunk_count)) return null;

    const headers = new Headers(safeHeaders(manifest.headers_json));
    headers.set('x-api-source', 'worker-materialized');
    headers.set('x-materialized-at', String(manifest.updated_at));
    return new Response(rows.map((row) => String(row.payload_chunk || '')).join(''), {
      status: Number(manifest.status) || 200,
      headers,
    });
  } catch (error) {
    if (/no such table/i.test(String(error?.message || error))) return null;
    console.error(error);
    return null;
  }
}

function sharedResponse(origin) {
  const headers = new Headers(origin.headers);
  if (origin.ok) {
    headers.set(
      'cache-control',
      `public, max-age=${API_BROWSER_TTL_SECONDS}, s-maxage=${API_EDGE_TTL_SECONDS}, stale-while-revalidate=${API_EDGE_TTL_SECONDS * 2}`,
    );
  }
  headers.set('vary', 'accept-encoding');
  return new Response(origin.body, {
    status: origin.status,
    statusText: origin.statusText,
    headers,
  });
}

export async function onRequest(context) {
  const { request } = context;
  if (!edgeCacheableApiRequest(request)) return context.next();

  const cache = caches.default;
  const cacheKey = canonicalApiCacheRequest(request);
  const hit = await cache.match(cacheKey);
  if (hit) return tagged(hit, 'HIT');

  const key = cacheKey.url;
  let task = inFlight.get(key);
  const coalesced = Boolean(task);
  if (!task) {
    task = (async () => {
      const modelKey = materializedApiKey(new URL(request.url));
      const prebuilt = await materializedResponse(context, modelKey);
      const origin = prebuilt || await context.next();
      const shared = sharedResponse(origin);
      if (shared.ok) context.waitUntil(cache.put(cacheKey, shared.clone()));
      return shared;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, task);
  }

  return tagged(await task, coalesced ? 'COALESCED' : 'MISS');
}
