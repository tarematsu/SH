const STATIONHEAD_API_ORIGIN = 'https://production1.stationhead.com';
const STATIONHEAD_API_PREFIX = `${STATIONHEAD_API_ORIGIN}/station/`;
const STATIONHEAD_READ_CACHE_MAX = 32;
const STATIONHEAD_READ_CACHE_MARK = Symbol.for('stationhead-monitor.stationhead-read-cache');

function cacheableStationheadRead(input, init, now) {
  const rawUrl = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input?.url;
  if (!rawUrl || !String(rawUrl).startsWith(STATIONHEAD_API_PREFIX)) return null;

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.origin !== STATIONHEAD_API_ORIGIN) return null;

  const method = String(init?.method || input?.method || 'GET').toUpperCase();
  const chatHistory = method === 'GET' && /\/station\/[^/]+\/chatHistory\/?$/i.test(url.pathname);
  const stationGuest = method === 'POST' && /\/station\/handle\/[^/]+\/guest\/?$/i.test(url.pathname);
  if (!chatHistory && !stationGuest) return null;

  let body = '';
  if (stationGuest) {
    if (init?.body == null) {
      if (typeof Request === 'function' && input instanceof Request) return null;
    } else if (typeof init.body === 'string') {
      body = init.body;
    } else {
      return null;
    }
    if (body.trim() && body.trim() !== '{}') return null;
  }

  const headers = new Headers(init?.headers || input?.headers || undefined);
  const deviceUid = headers.get('sth-device-uid') || '';
  const authorization = headers.get('authorization') || '';
  const minute = Math.floor(now / 60_000);
  return {
    minute,
    key: [method, url.toString(), body, deviceUid, authorization].join('\n'),
  };
}

export function createStationheadReadFetch(nativeFetch, nowFn = Date.now) {
  if (typeof nativeFetch !== 'function') throw new TypeError('nativeFetch must be a function');
  const cache = new Map();
  let cacheMinute = null;

  const cachedFetch = async (input, init = {}) => {
    const now = Number(nowFn()) || Date.now();
    const request = cacheableStationheadRead(input, init, now);
    if (!request) return nativeFetch(input, init);

    if (cacheMinute !== request.minute) {
      cache.clear();
      cacheMinute = request.minute;
    }

    const existing = cache.get(request.key);
    if (existing) return (await existing).clone();

    while (cache.size >= STATIONHEAD_READ_CACHE_MAX) {
      cache.delete(cache.keys().next().value);
    }

    const pending = Promise.resolve()
      .then(() => nativeFetch(input, init))
      .then((response) => {
        if (!response?.ok) cache.delete(request.key);
        return response;
      })
      .catch((error) => {
        cache.delete(request.key);
        throw error;
      });
    cache.set(request.key, pending);
    return (await pending).clone();
  };

  Object.defineProperty(cachedFetch, STATIONHEAD_READ_CACHE_MARK, { value: true });
  return cachedFetch;
}

if (typeof globalThis.fetch === 'function' && !globalThis.fetch[STATIONHEAD_READ_CACHE_MARK]) {
  globalThis.fetch = createStationheadReadFetch(globalThis.fetch.bind(globalThis));
}

const TRACK_METADATA_CACHE_TTL_MS = 30 * 60 * 1000;
const TRACK_METADATA_CACHE_MAX = 16;
const trackMetadataQueueCache = new Map();

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function normalizeBearer(value) {
  return String(value || '').replace(/^Bearer\s+/i, '').trim();
}

export function jwtExpiryMs(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return 0;
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded));
    return Number(payload.exp || 0) * 1000;
  } catch {
    return 0;
  }
}

export function positiveNumber(value, fallback) {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function highResolutionArtwork(url) {
  if (!url) return null;
  return String(url)
    .replace(/\/\d+x\d+bb\./, '/600x600bb.')
    .replace(/\/\d+x\d+-\d+\./, '/600x600-75.');
}

export function cleanSpotifyTitle(rawTitle) {
  const cleaned = String(rawTitle || '')
    .replace(/\s*\|\s*Spotify\s*$/i, '')
    .trim();
  const parts = cleaned.split(/\s+[—–]\s+/);
  return {
    title: parts[0] || rawTitle || null,
    artist: parts.length > 1 ? parts.slice(1).join(' — ') : null,
    displayTitle: cleaned || rawTitle || null,
  };
}

function commentIdentity(comment) {
  if (comment?.comment_id != null) return `numeric:${comment.comment_id}`;
  const rawId = String(comment?.id ?? '').trim();
  return rawId ? `raw:${rawId}` : null;
}

export function normalizeComments(payload, stationId, { finite } = {}) {
  const toFinite = finite || ((value) => {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  });
  const candidates = [payload, payload?.items, payload?.data?.items, payload?.chats?.items, payload?.chats];
  const items = candidates.find(Array.isArray) || [];
  const normalized = items.map((chat) => ({
    comment_id: toFinite(chat?.id),
    id: chat?.id,
    station_id: toFinite(chat?.station_id ?? stationId),
    account_id: toFinite(chat?.account_id ?? chat?.account?.id),
    handle: chat?.account?.handle ?? null,
    text: chat?.text ?? null,
    text_with_xml: chat?.text_with_xml ?? null,
    chat_time: toFinite(chat?.chat_time),
    chat_time_ms: toFinite(chat?.chat_time_ms),
    all_access_chat: chat?.all_access_chat ?? null,
    boost_chat: chat?.boost_chat ?? null,
    followers: toFinite(chat?.account?.followers),
    following: toFinite(chat?.account?.following),
    active_stream_days: toFinite(chat?.active_stream_days ?? chat?.account?.active_stream_days),
    emoji: chat?.account?.emoji ?? null,
    raw: chat,
  })).filter((comment) => comment.comment_id != null || comment.id != null);

  const seen = new Set();
  const deduped = [];
  for (const comment of normalized) {
    const identity = commentIdentity(comment);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    deduped.push(comment);
  }
  return deduped;
}

export async function fetchTrackMetadata(track, config) {
  const spotifyId = track?.spotify_id;
  if (!spotifyId) return null;

  const spotifyUrl = `https://open.spotify.com/track/${encodeURIComponent(spotifyId)}`;
  const spotify = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  }).then((response) => response.ok ? response.json() : null).catch(() => null);
  if (!spotify?.title) return null;

  const parsed = cleanSpotifyTitle(spotify.title);
  const title = parsed.title;
  const artist = String(spotify.author_name || spotify.author || '').trim()
    || parsed.artist
    || null;
  return {
    spotify_id: spotifyId,
    spotify_url: spotifyUrl,
    title,
    artist,
    display_title: title && artist ? `${title} — ${artist}` : parsed.displayTitle,
    thumbnail_url: spotify.thumbnail_url || null,
    source: 'spotify_oembed',
    fetched_at: Date.now(),
    raw: { spotify },
  };
}

function completeMetadata(value, spotifyId = '') {
  const title = String(value?.title || '').trim();
  const artist = String(value?.artist || '').trim();
  return Boolean(
    title && artist
    && title !== spotifyId
    && artist !== spotifyId
    && !/^JP[A-Z0-9]{8,}$/i.test(artist),
  );
}

function metadataQueueKey(candidates) {
  return candidates.map((track) => String(track.spotify_id)).sort().join(',');
}

function cachedMetadataComplete(key, now = Date.now()) {
  const cached = trackMetadataQueueCache.get(key);
  if (!cached || cached.expiresAt <= now) {
    if (cached) trackMetadataQueueCache.delete(key);
    return false;
  }
  trackMetadataQueueCache.delete(key);
  trackMetadataQueueCache.set(key, cached);
  return true;
}

function markMetadataComplete(key) {
  trackMetadataQueueCache.delete(key);
  trackMetadataQueueCache.set(key, { expiresAt: Date.now() + TRACK_METADATA_CACHE_TTL_MS });
  while (trackMetadataQueueCache.size > TRACK_METADATA_CACHE_MAX) {
    trackMetadataQueueCache.delete(trackMetadataQueueCache.keys().next().value);
  }
}

export function resetTrackMetadataQueueCache() {
  trackMetadataQueueCache.clear();
}

export async function enrichTracks(env, ingestFn, queue, observedAt, config) {
  const unique = new Map();
  for (const track of queue?.tracks || []) {
    if (track?.spotify_id) unique.set(track.spotify_id, track);
  }
  const candidates = [...unique.values()];
  if (!candidates.length || (config.metadataLimit != null && config.metadataLimit <= 0)) return 0;

  const cacheKey = metadataQueueKey(candidates);
  if (cachedMetadataComplete(cacheKey)) return 0;

  const placeholders = candidates.map(() => '?').join(',');
  const stored = await env.DB.prepare(`
    SELECT spotify_id, title, artist
    FROM sh_track_metadata
    WHERE spotify_id IN (${placeholders})
  `).bind(...candidates.map((track) => track.spotify_id)).all();
  const complete = new Set((stored.results || [])
    .filter((item) => completeMetadata(item, item.spotify_id))
    .map((item) => item.spotify_id));
  const allMissing = candidates.filter((track) => !complete.has(track.spotify_id));
  if (!allMissing.length) {
    markMetadataComplete(cacheKey);
    return 0;
  }

  const limit = config.metadataLimit ?? 3;
  const missing = allMissing.slice(0, limit);
  const metadata = [];
  for (const track of missing) {
    const item = await fetchTrackMetadata(track, config);
    if (item) metadata.push(item);
  }
  if (metadata.length) await ingestFn(env, 'track_metadata', { tracks: metadata }, observedAt);

  const completeFetched = metadata.filter((item) => completeMetadata(item, item.spotify_id)).length;
  if (allMissing.length <= limit && completeFetched === allMissing.length) markMetadataComplete(cacheKey);
  else trackMetadataQueueCache.delete(cacheKey);
  return metadata.length;
}
