import {
  integer,
  normalizedIsrc,
  queueStructuralHash as computeQueueStructuralHash,
  queueStructurePayload as buildQueueStructurePayload,
  text,
  timestampMs,
} from './minute-facts-normalize.js';

const QUEUE_STRUCTURE_CACHE_LIMIT = 16;
const queueStructureCache = new Map();
let payloadEntries = new WeakMap();

function sameInteger(value, expected) {
  return value === expected || integer(value) === expected;
}

function sameTimestamp(value, expected) {
  return value === expected || timestampMs(value) === expected;
}

function sameText(value, expected) {
  return value === expected || text(value) === expected;
}

function sameIsrc(value, expected) {
  return value === expected || normalizedIsrc(value) === expected;
}

function queueMatchesPayload(queue, payload) {
  if (!sameInteger(queue?.queue_id, payload.queue_id)
      || !sameTimestamp(queue?.start_time, payload.start_time)) {
    return false;
  }
  const tracks = Array.isArray(queue?.tracks) ? queue.tracks : [];
  if (tracks.length !== payload.tracks.length) return false;

  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    const expected = payload.tracks[index];
    const position = integer(track?.position) ?? index;
    if (position !== expected.position
        || !sameInteger(track?.queue_track_id, expected.queue_track_id)
        || !sameInteger(track?.stationhead_track_id, expected.stationhead_track_id)
        || !sameIsrc(track?.isrc, expected.isrc)
        || !sameText(track?.spotify_id, expected.spotify_id)
        || !sameText(track?.deezer_id, expected.deezer_id)
        || !sameInteger(track?.duration_ms, expected.duration_ms)) {
      return false;
    }
  }
  return true;
}

function cacheKey(queue) {
  return `${integer(queue?.queue_id) ?? 'null'}:${timestampMs(queue?.start_time) ?? 'null'}`;
}

function remember(key, entry) {
  if (!queueStructureCache.has(key) && queueStructureCache.size >= QUEUE_STRUCTURE_CACHE_LIMIT) {
    const oldest = queueStructureCache.keys().next().value;
    if (oldest !== undefined) queueStructureCache.delete(oldest);
  }
  queueStructureCache.delete(key);
  queueStructureCache.set(key, entry);
  payloadEntries.set(entry.payload, entry);
}

export function queueStructurePayload(queue) {
  const key = cacheKey(queue);
  const cached = queueStructureCache.get(key);
  if (cached && queueMatchesPayload(queue, cached.payload)) {
    queueStructureCache.delete(key);
    queueStructureCache.set(key, cached);
    return cached.payload;
  }

  const payload = buildQueueStructurePayload(queue);
  remember(key, { payload, hash: null });
  return payload;
}

export async function queueStructuralHash(queue, payload = null) {
  const normalized = payload ?? queueStructurePayload(queue);
  const entry = payloadEntries.get(normalized);
  if (entry?.hash) return entry.hash;
  const hash = await computeQueueStructuralHash(queue, normalized);
  if (entry) entry.hash = hash;
  return hash;
}

export function resetQueueStructureCacheForTests() {
  queueStructureCache.clear();
  payloadEntries = new WeakMap();
}
