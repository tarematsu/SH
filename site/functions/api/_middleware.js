import { BLOCKED_API_PATHS } from '../lib/api-contract.js';

const inFlight = new Map();
const blockedApiPaths = new Set(BLOCKED_API_PATHS);

function normalizedPathname(value) {
  const pathname = String(value || '/');
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

export function isBlockedApiPath(pathname) {
  return blockedApiPaths.has(normalizedPathname(pathname));
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

function cachePolicy(url) {
  if (url.pathname === '/api/dashboard-history') return { ttl: 300, browser: 60 };
  if (url.pathname === '/api/minute-facts/current') return { ttl: 60, browser: 30 };
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

function parsedQueue(value) {
  try {
    const parsed = JSON.parse(value || 'null');
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.queue)) return parsed.queue;
    if (Array.isArray(parsed?.tracks)) return parsed.tracks;
    if (Array.isArray(parsed?.queue_tracks)) return parsed.queue_tracks;
  } catch {
    // Leave the playback response unchanged when the read model is malformed.
  }
  return [];
}

function metadataKey(track) {
  const spotifyId = String(track?.spotify_id || '').trim();
  if (spotifyId) return `spotify:${spotifyId}`;
  const isrc = String(track?.isrc || '').trim().toUpperCase();
  return isrc ? `isrc:${isrc}` : null;
}

async function enrichPlaybackResponse(context) {
  const origin = await context.next();
  if (!origin.ok || !context.env?.MINUTE_DB || !context.env?.DB) return origin;

  let payload;
  try {
    payload = await origin.clone().json();
  } catch {
    return origin;
  }
  if (!payload?.ok || !Array.isArray(payload.queue) || !payload.queue.some((track) => (
    !track?.title || !track?.artist || !track?.thumbnail_url
  ))) return origin;

  try {
    const row = await context.env.MINUTE_DB.prepare(`SELECT queue_json
      FROM sh_queue_read_model_current
      ORDER BY observed_at DESC
      LIMIT 1`).first();
    const source = parsedQueue(row?.queue_json);
    if (!source.length) return origin;

    const spotifyIds = [...new Set(source.map((track) => String(track?.spotify_id || '').trim()).filter(Boolean))].slice(0, 80);
    const isrcs = [...new Set(source.map((track) => String(track?.isrc || '').trim().toUpperCase()).filter(Boolean))].slice(0, 80);
    if (!spotifyIds.length && !isrcs.length) return origin;

    const clauses = [];
    const bindings = [];
    if (spotifyIds.length) {
      clauses.push(`spotify_id IN (${spotifyIds.map(() => '?').join(',')})`);
      bindings.push(...spotifyIds);
    }
    if (isrcs.length) {
      clauses.push(`isrc IN (${isrcs.map(() => '?').join(',')})`);
      bindings.push(...isrcs);
    }
    const result = await context.env.DB.prepare(`SELECT spotify_id,isrc,title,artist,thumbnail_url,fetched_at
      FROM sh_track_metadata
      WHERE ${clauses.join(' OR ')}
      ORDER BY fetched_at DESC`).bind(...bindings).all();

    const metadata = new Map();
    for (const item of result.results || []) {
      const spotifyKey = String(item?.spotify_id || '').trim();
      const isrcKey = String(item?.isrc || '').trim().toUpperCase();
      if (spotifyKey && !metadata.has(`spotify:${spotifyKey}`)) metadata.set(`spotify:${spotifyKey}`, item);
      if (isrcKey && !metadata.has(`isrc:${isrcKey}`)) metadata.set(`isrc:${isrcKey}`, item);
    }

    let changed = false;
    payload.queue = payload.queue.map((track, index) => {
      const sourceTrack = source.find((item) => Number(item?.position) === index) || source[index];
      const meta = metadata.get(metadataKey(sourceTrack));
      if (!meta) return track;
      const title = track.title || meta.title || null;
      const artist = track.artist || meta.artist || null;
      const thumbnailUrl = track.thumbnail_url || meta.thumbnail_url || null;
      if (title === track.title && artist === track.artist && thumbnailUrl === track.thumbnail_url) return track;
      changed = true;
      return { ...track, title, artist, thumbnail_url: thumbnailUrl };
    });
    if (!changed) return origin;

    const headers = new Headers(origin.headers);
    headers.delete('content-length');
    return new Response(JSON.stringify(payload), {
      status: origin.status,
      statusText: origin.statusText,
      headers,
    });
  } catch (error) {
    console.error('playback metadata enrichment failed', error);
    return origin;
  }
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  if (isBlockedApiPath(url.pathname)) return notFoundResponse();
  if (request.method === 'GET' && url.pathname === '/api/playback' && !url.searchParams.has('channel')) {
    return enrichPlaybackResponse(context);
  }
  if (request.method !== 'GET' || request.headers.has('authorization')) return context.next();

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

  return tagged(await task, coalesced ? 'COALESCED' : 'MISS');
}
