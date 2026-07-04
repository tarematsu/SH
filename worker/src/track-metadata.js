import { cleanSpotifyTitle } from './shared-utils.js';

const COMPLETE_CACHE_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 24 * 60 * 60 * 1000;
const FAILURE_RETRY_MS = 15 * 60 * 1000;
const CACHE_MAX = 512;
const metadataCache = new Map();

function pruneCache() {
  while (metadataCache.size > CACHE_MAX) {
    metadataCache.delete(metadataCache.keys().next().value);
  }
}

function cacheMetadataState(spotifyId, expiresAt) {
  metadataCache.delete(spotifyId);
  metadataCache.set(spotifyId, { expiresAt });
  pruneCache();
}

function metadataStateCached(spotifyId, now = Date.now()) {
  const cached = metadataCache.get(spotifyId);
  if (!cached || cached.expiresAt <= now) {
    if (cached) metadataCache.delete(spotifyId);
    return false;
  }
  metadataCache.delete(spotifyId);
  metadataCache.set(spotifyId, cached);
  return true;
}

export async function fetchTrackMetadata(track, config) {
  const spotifyId = track?.spotify_id;
  if (!spotifyId) return null;

  const spotifyUrl = `https://open.spotify.com/track/${encodeURIComponent(spotifyId)}`;
  const spotify = await fetch(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`,
    {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    },
  ).then((response) => response.ok ? response.json() : null).catch(() => null);
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

export function metadataNeedsRefresh(value, spotifyId = '', now = Date.now()) {
  if (completeMetadata(value, spotifyId)) return false;
  const fetchedAt = Number(value?.fetched_at || 0);
  return !Number.isFinite(fetchedAt)
    || fetchedAt <= 0
    || now - fetchedAt >= RETRY_MS;
}

export function isrcMetadataRepairRows(rows, now = Date.now()) {
  return (rows || [])
    .filter((row) => completeMetadata(row, row?.spotify_id))
    .map((row) => ({
      spotify_id: String(row.spotify_id),
      title: String(row.title).trim(),
      artist: String(row.artist).trim(),
      display_title: `${String(row.title).trim()} — ${String(row.artist).trim()}`,
      thumbnail_url: row.thumbnail_url || null,
      spotify_url: `https://open.spotify.com/track/${encodeURIComponent(row.spotify_id)}`,
      source: 'isrc_peer',
      fetched_at: now,
      raw: {
        resolved_from_spotify_id: row.peer_spotify_id || null,
        isrc: row.isrc || null,
      },
    }));
}

function isrcCandidates(tracks) {
  const unique = new Map();
  for (const track of tracks) {
    const spotifyId = String(track?.spotify_id || '').trim();
    const isrc = String(track?.isrc || '').trim().toUpperCase();
    if (spotifyId && isrc) unique.set(spotifyId, { spotifyId, isrc });
  }
  return [...unique.values()];
}

async function repairMetadataFromIsrc(db, tracks, now) {
  const candidates = isrcCandidates(tracks);
  if (!candidates.length) return new Set();

  const valuesSql = candidates.map(() => '(?, ?)').join(',');
  const bindings = candidates.flatMap((candidate) => [candidate.spotifyId, candidate.isrc]);
  const result = await db.prepare(`WITH candidates(spotify_id,isrc) AS (
      VALUES ${valuesSql}
    ), ranked AS (
      SELECT candidates.spotify_id,candidates.isrc,
        peer.spotify_id AS peer_spotify_id,
        metadata.title,metadata.artist,metadata.thumbnail_url,
        ROW_NUMBER() OVER (
          PARTITION BY candidates.spotify_id
          ORDER BY peer.observed_at DESC,metadata.fetched_at DESC
        ) AS row_rank
      FROM candidates
      JOIN sh_queue_items peer
        ON peer.isrc=candidates.isrc
       AND peer.spotify_id IS NOT NULL
       AND peer.spotify_id<>''
       AND peer.spotify_id<>candidates.spotify_id
      JOIN sh_track_metadata metadata ON metadata.spotify_id=peer.spotify_id
      WHERE metadata.title IS NOT NULL AND metadata.title<>''
        AND metadata.artist IS NOT NULL AND metadata.artist<>''
        AND metadata.title<>metadata.spotify_id
        AND metadata.artist<>metadata.spotify_id
        AND metadata.artist NOT GLOB 'JP[A-Z0-9]*'
    )
    SELECT spotify_id,isrc,peer_spotify_id,title,artist,thumbnail_url
    FROM ranked WHERE row_rank=1`).bind(...bindings).all();

  const repairs = isrcMetadataRepairRows(result.results || [], now);
  if (repairs.length) {
    await db.batch(repairs.map((row) => db.prepare(`INSERT INTO sh_track_metadata(
        spotify_id,title,artist,display_title,thumbnail_url,spotify_url,
        source,fetched_at,raw_json
      ) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(spotify_id) DO UPDATE SET
        title=excluded.title,
        artist=excluded.artist,
        display_title=excluded.display_title,
        thumbnail_url=COALESCE(excluded.thumbnail_url,sh_track_metadata.thumbnail_url),
        spotify_url=excluded.spotify_url,
        source=excluded.source,
        fetched_at=MAX(excluded.fetched_at,sh_track_metadata.fetched_at),
        raw_json=excluded.raw_json
      WHERE sh_track_metadata.title IS NULL
         OR sh_track_metadata.title=''
         OR sh_track_metadata.artist IS NULL
         OR sh_track_metadata.artist=''
         OR sh_track_metadata.title=sh_track_metadata.spotify_id
         OR sh_track_metadata.artist=sh_track_metadata.spotify_id
         OR sh_track_metadata.artist GLOB 'JP[A-Z0-9]*'`)
      .bind(
        row.spotify_id,
        row.title,
        row.artist,
        row.display_title,
        row.thumbnail_url,
        row.spotify_url,
        row.source,
        row.fetched_at,
        JSON.stringify(row.raw),
      )));
  }
  return new Set(repairs.map((row) => row.spotify_id));
}

export function resetTrackMetadataQueueCache() {
  metadataCache.clear();
}

export async function enrichTracks(env, ingestFn, queue, observedAt, config) {
  const unique = new Map();
  for (const track of queue?.tracks || []) {
    if (track?.spotify_id) unique.set(String(track.spotify_id), track);
  }
  const candidates = [...unique.values()];
  if (!candidates.length || (config.metadataLimit != null && config.metadataLimit <= 0)) return 0;

  const now = Date.now();
  const uncached = candidates.filter((track) => !metadataStateCached(String(track.spotify_id), now));
  if (!uncached.length) return 0;

  const spotifyIds = uncached.map((track) => String(track.spotify_id));
  const placeholders = spotifyIds.map(() => '?').join(',');
  const stored = await env.DB.prepare(`SELECT spotify_id,title,artist,fetched_at
    FROM sh_track_metadata WHERE spotify_id IN (${placeholders})`)
    .bind(...spotifyIds).all();
  const storedById = new Map((stored.results || []).map((item) => [String(item.spotify_id), item]));

  const complete = new Set();
  for (const item of stored.results || []) {
    const spotifyId = String(item.spotify_id);
    if (completeMetadata(item, spotifyId)) {
      complete.add(spotifyId);
      cacheMetadataState(spotifyId, now + COMPLETE_CACHE_MS);
    }
  }

  const unresolved = uncached.filter((track) => !complete.has(String(track.spotify_id)));
  if (unresolved.length) {
    const repaired = await repairMetadataFromIsrc(env.DB, unresolved, now);
    for (const spotifyId of repaired) {
      complete.add(spotifyId);
      cacheMetadataState(spotifyId, now + COMPLETE_CACHE_MS);
    }
  }

  const retryable = unresolved.filter((track) => {
    const spotifyId = String(track.spotify_id);
    if (complete.has(spotifyId)) return false;
    const storedItem = storedById.get(spotifyId);
    if (!metadataNeedsRefresh(storedItem, spotifyId, now)) {
      const fetchedAt = Number(storedItem?.fetched_at || now);
      cacheMetadataState(spotifyId, Math.max(now + 60_000, fetchedAt + RETRY_MS));
      return false;
    }
    return true;
  });
  if (!retryable.length) return 0;

  const limit = config.metadataLimit ?? 3;
  const missing = retryable.slice(0, limit);
  const metadata = [];
  for (const track of missing) {
    const item = await fetchTrackMetadata(track, config);
    const spotifyId = String(track.spotify_id);
    if (!item) {
      cacheMetadataState(spotifyId, now + FAILURE_RETRY_MS);
      continue;
    }
    metadata.push(item);
    cacheMetadataState(
      spotifyId,
      completeMetadata(item, spotifyId) ? now + COMPLETE_CACHE_MS : now + RETRY_MS,
    );
  }
  if (metadata.length) {
    await ingestFn(env, 'track_metadata', { tracks: metadata }, observedAt);
  }
  return metadata.length;
}
