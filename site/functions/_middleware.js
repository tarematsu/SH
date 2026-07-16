import {
  API_BROWSER_TTL_SECONDS,
  API_EDGE_TTL_SECONDS,
  PLAYBACK_EDGE_TTL_SECONDS,
  apiCacheTtlSeconds,
  canonicalApiCacheRequest,
  edgeCacheableApiRequest,
  materializedApiKey,
  materializedResponseMaximumAge,
} from './lib/api-contract.js';

const MATERIALIZED_RETRY_TTL_SECONDS = 30;
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

function materializedCadenceSeconds(modelKey) {
  return String(modelKey || '').startsWith('playback:')
    ? PLAYBACK_EDGE_TTL_SECONDS
    : API_EDGE_TTL_SECONDS;
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
    if (now - Number(manifest.updated_at || 0) > materializedResponseMaximumAge(modelKey, context.env)) {
      return null;
    }

    const result = await db.prepare(`SELECT payload_chunk
      FROM sh_pages_response_chunks
      WHERE model_key=? AND generation=?
      ORDER BY chunk_index ASC`).bind(modelKey, manifest.generation).all();
    const rows = result.results || [];
    if (rows.length !== Number(manifest.chunk_count)) return null;

    const headers = new Headers(safeHeaders(manifest.headers_json));
    headers.set('x-api-source', 'worker-materialized');
    headers.set('x-materialized-at', String(manifest.updated_at));
    headers.set('x-materialized-cadence-seconds', String(materializedCadenceSeconds(modelKey)));
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

function responseCacheTtl(origin, requestedTtl, modelKey, usedMaterialized, now) {
  if (!usedMaterialized) {
    return modelKey ? MATERIALIZED_RETRY_TTL_SECONDS : requestedTtl;
  }
  const updatedAt = Number(origin.headers.get('x-materialized-at'));
  const cadenceSeconds = Number(origin.headers.get('x-materialized-cadence-seconds'));
  if (!Number.isFinite(updatedAt) || !Number.isFinite(cadenceSeconds) || cadenceSeconds <= 0) {
    return MATERIALIZED_RETRY_TTL_SECONDS;
  }
  const remainingSeconds = Math.floor((updatedAt + cadenceSeconds * 1000 - now) / 1000);
  if (remainingSeconds <= 0) return MATERIALIZED_RETRY_TTL_SECONDS;
  return Math.max(1, Math.min(requestedTtl, remainingSeconds));
}

function sharedResponse(origin, ttlSeconds) {
  const headers = new Headers(origin.headers);
  if (origin.ok) {
    const browserTtl = Math.min(API_BROWSER_TTL_SECONDS, ttlSeconds);
    headers.set(
      'cache-control',
      `public, max-age=${browserTtl}, s-maxage=${ttlSeconds}, stale-while-revalidate=${ttlSeconds * 2}`,
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
      const now = Date.now();
      const modelKey = materializedApiKey(new URL(request.url));
      const prebuilt = await materializedResponse(context, modelKey, now);
      const origin = prebuilt || await context.next();
      const ttlSeconds = responseCacheTtl(
        origin,
        apiCacheTtlSeconds(request),
        modelKey,
        Boolean(prebuilt),
        now,
      );
      const shared = sharedResponse(origin, ttlSeconds);
      if (shared.ok) context.waitUntil(cache.put(cacheKey, shared.clone()));
      return shared;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, task);
  }

  return tagged(await task, coalesced ? 'COALESCED' : 'MISS');
}
