import { fetchTrackMetadata, metadataNeedsRefresh } from './shared.js';
import { currentIndex } from './buddy-playback-queue.js';

const METADATA_FAILURE_RETRY_MS = 15 * 60_000;
const METADATA_FAILURE_CACHE_MAX = 256;
const BUDDY_METADATA_TABLE = 'sh_buddy_track_metadata';

const metadataFailureUntil = new Map();

function trimMetadataFailures() {
  while (metadataFailureUntil.size > METADATA_FAILURE_CACHE_MAX) {
    metadataFailureUntil.delete(metadataFailureUntil.keys().next().value);
  }
}

function metadataRetryBlocked(spotifyId, now) {
  const retryAt = Number(metadataFailureUntil.get(spotifyId) || 0);
  if (retryAt > now) return true;
  if (retryAt) metadataFailureUntil.delete(spotifyId);
  return false;
}

function markMetadataFailure(spotifyId, now) {
  metadataFailureUntil.set(spotifyId, now + METADATA_FAILURE_RETRY_MS);
  trimMetadataFailures();
}

export function resetMetadataFailureCache() {
  metadataFailureUntil.clear();
}

function normalizedIsrc(value) {
  return String(value || '').trim().toUpperCase();
}

function metadataForTrack(metadata, track) {
  const isrc = normalizedIsrc(track?.isrc);
  const spotifyId = String(track?.spotify_id || '').trim();
  return (isrc ? metadata.get(`isrc:${isrc}`) : null)
    || (spotifyId ? metadata.get(`spotify:${spotifyId}`) : null)
    || (spotifyId ? metadata.get(spotifyId) : null)
    || null;
}

function indexMetadataRows(rows) {
  const metadata = new Map();
  for (const row of rows || []) {
    const spotifyId = String(row?.spotify_id || '').trim();
    const isrc = normalizedIsrc(row?.isrc);
    if (spotifyId) {
      metadata.set(spotifyId, row);
      metadata.set(`spotify:${spotifyId}`, row);
    }
    if (isrc && !metadata.has(`isrc:${isrc}`)) metadata.set(`isrc:${isrc}`, row);
  }
  return metadata;
}

async function loadTrackMetadata(db, tracks) {
  const spotifyIds = [...new Set(tracks.map((track) => String(track?.spotify_id || '').trim()).filter(Boolean))];
  const isrcs = [...new Set(tracks.map((track) => normalizedIsrc(track?.isrc)).filter(Boolean))];
  if (!spotifyIds.length && !isrcs.length) return new Map();

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
  const result = await db.prepare(`SELECT spotify_id,isrc,title,artist,display_title,
      thumbnail_url,spotify_url,fetched_at,raw_json
    FROM ${BUDDY_METADATA_TABLE} WHERE ${clauses.join(' OR ')}
    ORDER BY fetched_at DESC`)
    .bind(...bindings).all();
  return indexMetadataRows(result.results || []);
}

async function saveTrackMetadata(db, rows) {
  if (!rows.length) return;
  await db.batch(rows.map((row) => db.prepare(`INSERT INTO ${BUDDY_METADATA_TABLE} (
      spotify_id,isrc,title,artist,display_title,thumbnail_url,spotify_url,source,fetched_at,raw_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(spotify_id) DO UPDATE SET
      isrc=COALESCE(excluded.isrc,${BUDDY_METADATA_TABLE}.isrc),
      title=COALESCE(excluded.title,${BUDDY_METADATA_TABLE}.title),
      artist=COALESCE(excluded.artist,${BUDDY_METADATA_TABLE}.artist),
      display_title=COALESCE(excluded.display_title,${BUDDY_METADATA_TABLE}.display_title),
      thumbnail_url=COALESCE(excluded.thumbnail_url,${BUDDY_METADATA_TABLE}.thumbnail_url),
      spotify_url=COALESCE(excluded.spotify_url,${BUDDY_METADATA_TABLE}.spotify_url),
      source=COALESCE(excluded.source,${BUDDY_METADATA_TABLE}.source),
      fetched_at=MAX(excluded.fetched_at,${BUDDY_METADATA_TABLE}.fetched_at),
      raw_json=CASE WHEN excluded.raw_json IS NOT NULL THEN excluded.raw_json ELSE ${BUDDY_METADATA_TABLE}.raw_json END`)
    .bind(
      row.spotify_id,
      normalizedIsrc(row.isrc) || null,
      row.title,
      row.artist,
      row.display_title,
      row.thumbnail_url,
      row.spotify_url,
      row.source,
      row.fetched_at,
      JSON.stringify(row.raw || {}),
    )));
}

function buddyMetadataNeedsRefresh(row, track, now) {
  const spotifyId = String(track?.spotify_id || '').trim();
  if (!spotifyId) return false;
  if (metadataNeedsRefresh(row, spotifyId, now)) return true;
  return !row?.title
    || !row?.artist
    || (!row?.thumbnail_url && !track?.thumbnail_url);
}

function orderedQueueTracks(queue, now) {
  const index = currentIndex(queue, now);
  return [
    ...queue.tracks.slice(Math.max(0, index)),
    ...queue.tracks.slice(0, Math.max(0, index)),
  ];
}

function missingMetadataTracks(ordered, metadata, now, limit = Number.MAX_SAFE_INTEGER) {
  const missing = [];
  const seen = new Set();
  for (const track of ordered) {
    const spotifyId = track.spotify_id;
    if (!spotifyId || seen.has(spotifyId) || metadataRetryBlocked(spotifyId, now)) continue;
    seen.add(spotifyId);
    if (buddyMetadataNeedsRefresh(metadataForTrack(metadata, track), track, now)) missing.push(track);
    if (missing.length >= limit) break;
  }
  return missing;
}

export async function enrichQueueMetadata(env, queue, now, config, fetchMetadata = fetchTrackMetadata) {
  if (!env?.OTHER_DB) throw new Error('OTHER_DB binding is missing for buddy playback metadata');
  const tracks = queue.tracks.filter((track) => track?.spotify_id || track?.isrc);
  const metadata = await loadTrackMetadata(env.OTHER_DB, tracks);
  const withDetails = config?.returnDetails === true;
  if (!tracks.some((track) => track.spotify_id) || config.metadataLimit <= 0) {
    return withDetails ? { metadata, fetched: 0, remaining: 0 } : metadata;
  }

  const ordered = orderedQueueTracks(queue, now);
  const missing = missingMetadataTracks(ordered, metadata, now, config.metadataLimit);
  const fetched = [];
  for (const track of missing) {
    let row = null;
    try {
      row = await fetchMetadata(track, config);
    } catch {
      row = null;
    }
    if (!row) {
      markMetadataFailure(track.spotify_id, now);
      continue;
    }
    metadataFailureUntil.delete(track.spotify_id);
    fetched.push(row);
    const spotifyId = String(row.spotify_id || '').trim();
    const isrc = normalizedIsrc(row.isrc);
    if (spotifyId) {
      metadata.set(spotifyId, row);
      metadata.set(`spotify:${spotifyId}`, row);
    }
    if (isrc) metadata.set(`isrc:${isrc}`, row);
  }
  await saveTrackMetadata(env.OTHER_DB, fetched);
  if (!withDetails) return metadata;
  return {
    metadata,
    fetched: fetched.length,
    remaining: missingMetadataTracks(ordered, metadata, now).length,
  };
}

export function attachBuddyMetadata(queue, metadata) {
  return queue.tracks.map((track) => {
    const row = metadataForTrack(metadata, track);
    const title = String(track?.title || row?.title || '').trim() || null;
    const artist = String(track?.artist || row?.artist || '').trim() || null;
    return {
      ...track,
      title,
      artist,
      album_name: String(track?.album_name || '').trim() || null,
      display_title: track?.display_title
        || row?.display_title
        || (title && artist ? `${title} — ${artist}` : title),
      thumbnail_url: track?.thumbnail_url || row?.thumbnail_url || null,
      spotify_url: track?.spotify_url
        || row?.spotify_url
        || (track.spotify_id ? `https://open.spotify.com/track/${track.spotify_id}` : null),
    };
  });
}
