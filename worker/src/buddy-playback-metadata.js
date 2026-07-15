import { fetchTrackMetadata, metadataNeedsRefresh } from './shared.js';
import { currentIndex } from './buddy-playback-queue.js';

const METADATA_FAILURE_RETRY_MS = 15 * 60_000;
const METADATA_FAILURE_CACHE_MAX = 256;

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

async function loadTrackMetadata(db, spotifyIds) {
  if (!spotifyIds.length) return new Map();
  const placeholders = spotifyIds.map(() => '?').join(',');
  const result = await db.prepare(`SELECT spotify_id,title,artist,display_title,
      thumbnail_url,spotify_url,fetched_at
    FROM sh_track_metadata WHERE spotify_id IN (${placeholders})`)
    .bind(...spotifyIds).all();
  return new Map((result.results || []).map((row) => [String(row.spotify_id), row]));
}

async function saveTrackMetadata(db, rows) {
  if (!rows.length) return;
  await db.batch(rows.map((row) => db.prepare(`INSERT INTO sh_track_metadata (
      spotify_id,title,artist,display_title,thumbnail_url,spotify_url,source,fetched_at,raw_json
    ) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(spotify_id) DO UPDATE SET
      title=excluded.title,artist=excluded.artist,display_title=excluded.display_title,
      thumbnail_url=COALESCE(excluded.thumbnail_url,sh_track_metadata.thumbnail_url),
      spotify_url=excluded.spotify_url,source=excluded.source,
      fetched_at=excluded.fetched_at,raw_json=excluded.raw_json`)
    .bind(
      row.spotify_id,
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
  return !row?.thumbnail_url && !track?.thumbnail_url;
}

export async function enrichQueueMetadata(env, queue, now, config, fetchMetadata = fetchTrackMetadata) {
  const spotifyIds = [...new Set(queue.tracks.map((track) => track.spotify_id).filter(Boolean))];
  // Primary track metadata is shared by the primary collector, Pages, and
  // buddy playback. Keep OTHER_DB as a one-release compatibility fallback so
  // an older deployment can still serve cached metadata during cutover.
  const metadataDb = env.BUDDIES_DB || env.OTHER_DB;
  const metadata = await loadTrackMetadata(metadataDb, spotifyIds);
  if (!spotifyIds.length || config.metadataLimit <= 0) return metadata;

  const index = currentIndex(queue, now);
  const ordered = [
    ...queue.tracks.slice(Math.max(0, index)),
    ...queue.tracks.slice(0, Math.max(0, index)),
  ];
  const missing = [];
  const seen = new Set();
  for (const track of ordered) {
    const spotifyId = track.spotify_id;
    if (!spotifyId || seen.has(spotifyId) || metadataRetryBlocked(spotifyId, now)) continue;
    seen.add(spotifyId);
    if (buddyMetadataNeedsRefresh(metadata.get(spotifyId), track, now)) missing.push(track);
    if (missing.length >= config.metadataLimit) break;
  }

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
    metadata.set(String(row.spotify_id), row);
  }
  await saveTrackMetadata(metadataDb, fetched);
  return metadata;
}

export function attachBuddyMetadata(queue, metadata) {
  return queue.tracks.map((track) => {
    const row = track.spotify_id ? metadata.get(String(track.spotify_id)) : null;
    const title = String(row?.title || '').trim() || null;
    const artist = String(row?.artist || '').trim() || null;
    return {
      ...track,
      title,
      artist,
      display_title: row?.display_title || (title && artist ? `${title} — ${artist}` : title),
      thumbnail_url: row?.thumbnail_url || track.thumbnail_url || null,
      spotify_url: row?.spotify_url
        || (track.spotify_id ? `https://open.spotify.com/track/${track.spotify_id}` : null),
    };
  });
}
