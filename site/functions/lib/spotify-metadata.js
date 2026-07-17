import { cleanText, looksLikeId } from './track-history-text.js';

const POSITIVE_CACHE_SECONDS = 30 * 24 * 60 * 60;
const NEGATIVE_CACHE_SECONDS = 60 * 60;

export function parseSpotifyTitle(value) {
  const cleaned = cleanText(value)?.replace(/\s*\|\s*Spotify\s*$/i, '') || null;
  if (!cleaned) return { title: null, artist: null };
  const match = cleaned.match(/^(.*?)\s*-\s*song and lyrics by\s*(.+)$/i);
  if (match) return { title: cleanText(match[1]), artist: cleanText(match[2]) };
  return { title: cleaned, artist: null };
}

function cacheRequest(spotifyId) {
  return new Request(`https://sh-meta-cache.invalid/spotify/${encodeURIComponent(spotifyId)}`);
}

async function readCache(request) {
  try {
    const cached = await globalThis.caches?.default?.match(request);
    if (!cached) return undefined;
    const value = await cached.json();
    return value?.missing ? null : value;
  } catch {
    return undefined;
  }
}

async function writeCache(request, value, maxAge) {
  try {
    await globalThis.caches?.default?.put(request, new Response(JSON.stringify(value), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': `public, max-age=${maxAge}`,
      },
    }));
  } catch {}
}

async function fetchUncached(spotifyId, timeoutMs) {
  const request = cacheRequest(spotifyId);
  const cached = await readCache(request);
  if (cached !== undefined) return cached;

  const spotifyUrl = `https://open.spotify.com/track/${encodeURIComponent(spotifyId)}`;
  try {
    const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      if (response.status !== 429 && response.status < 500) {
        await writeCache(request, { missing: true }, NEGATIVE_CACHE_SECONDS);
      }
      return null;
    }

    const raw = await response.json();
    const parsed = parseSpotifyTitle(raw?.title);
    const value = {
      title: parsed.title,
      artist: cleanText(raw?.author_name || raw?.author) || parsed.artist,
      spotify_url: spotifyUrl,
      raw,
    };
    if (!value.title || looksLikeId(value.title)) {
      await writeCache(request, { missing: true }, NEGATIVE_CACHE_SECONDS);
      return null;
    }

    await writeCache(request, value, POSITIVE_CACHE_SECONDS);
    return value;
  } catch {
    return null;
  }
}

export function fetchSpotifyMetadata(spotifyId, { timeoutMs = 5000 } = {}) {
  const id = cleanText(spotifyId);
  if (!id) return Promise.resolve(null);
  // Cache API entries are safe across requests. A module-level in-flight Promise
  // is not, because it may still be awaiting fetch or a response body created by
  // another Pages request. Concurrent misses therefore remain request-local.
  return fetchUncached(id, timeoutMs);
}

export async function fetchSpotifyMetadataBatch(ids, { concurrency = 6, timeoutMs = 5000 } = {}) {
  const unique = [...new Set((ids || []).map(cleanText).filter(Boolean))];
  const resolved = new Map();
  let cursor = 0;

  async function worker() {
    while (cursor < unique.length) {
      const id = unique[cursor];
      cursor += 1;
      const value = await fetchSpotifyMetadata(id, { timeoutMs });
      if (value) resolved.set(id, value);
    }
  }

  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), unique.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return resolved;
}
