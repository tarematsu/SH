import { payloadHash } from './ingest-claim.js';
import { bool, num, rawJson, text } from './api-utils.js';

const SNAPSHOT_CHECKPOINT_MS = 5 * 60_000;
const QUEUE_STRUCTURAL_PAYLOAD = Symbol.for('stationhead.queue.structural-payload');
const SNAPSHOT_HASH_CACHE_LIMIT = 16;
const SNAPSHOT_SIGNATURE_LENGTH = 23;
const snapshotHashCache = new Map();

export function resetSnapshotHashCacheForTests() {
  snapshotHashCache.clear();
}

function snapshotHashCacheFor(channelKey) {
  const existing = snapshotHashCache.get(channelKey);
  if (existing) return existing;
  if (snapshotHashCache.size >= SNAPSHOT_HASH_CACHE_LIMIT) {
    const oldest = snapshotHashCache.keys().next().value;
    if (oldest !== undefined) snapshotHashCache.delete(oldest);
  }
  const value = {};
  snapshotHashCache.set(channelKey, value);
  return value;
}

function snapshotRawPayload(data) {
  const presentation = data?.presentation;
  if (presentation && typeof presentation === 'object') {
    const currentStation = presentation.current_station || {};
    const owner = currentStation.owner || {};
    return {
      description: text(presentation.description || currentStation.status),
      artist_name: text(presentation.artist_name),
      accent_color: text(presentation.accent_color),
      images: {
        medium: { url: text(presentation.images?.medium?.url) },
        logo: { medium: { url: text(presentation.images?.logo?.medium?.url) } },
      },
      current_station: {
        status: text(currentStation.status),
        owner: {
          thumbnail: { url: text(owner.thumbnail?.url) },
          medium: { url: text(owner.medium?.url) },
        },
      },
    };
  }
  const raw = data?.raw || {};
  const station = raw.current_station || {};
  const owner = station.owner || {};
  return {
    description: text(raw.description || station.status),
    artist_name: text(raw.artist_name),
    accent_color: text(raw.accent_color),
    images: {
      medium: { url: text(raw.images?.medium?.url) },
      logo: { medium: { url: text(raw.images?.logo?.medium?.url) } },
    },
    current_station: {
      status: text(station.status),
      owner: {
        thumbnail: { url: text(owner.thumbnail?.url) },
        medium: { url: text(owner.medium?.url) },
      },
    },
  };
}

function snapshotHashPayload(data, reportedStreamCount, compactRaw) {
  return {
    channel_id: num(data?.channel_id),
    station_id: num(data?.station_id),
    is_launched: bool(data?.is_launched),
    is_broadcasting: bool(data?.is_broadcasting),
    chat_status: text(data?.chat_status),
    listener_count: num(data?.listener_count),
    online_member_count: num(data?.online_member_count),
    total_member_count: num(data?.total_member_count),
    guest_count: num(data?.guest_count),
    cumulative_listener_count: num(data?.total_listens),
    reported_stream_count: reportedStreamCount,
    stream_goal: num(data?.stream_goal),
    host_account_id: num(data?.host_account_id),
    host_handle: text(data?.host_handle),
    broadcast_start_time: num(data?.broadcast_start_time),
    metadata: compactRaw,
  };
}

function snapshotSignatureMatches(signature, payload) {
  if (!signature || signature.length !== SNAPSHOT_SIGNATURE_LENGTH) return false;
  const metadata = payload?.metadata || {};
  const images = metadata.images || {};
  const currentStation = metadata.current_station || {};
  const owner = currentStation.owner || {};
  return signature[0] === payload?.channel_id
    && signature[1] === payload?.station_id
    && signature[2] === payload?.is_launched
    && signature[3] === payload?.is_broadcasting
    && signature[4] === payload?.chat_status
    && signature[5] === payload?.listener_count
    && signature[6] === payload?.online_member_count
    && signature[7] === payload?.total_member_count
    && signature[8] === payload?.guest_count
    && signature[9] === payload?.cumulative_listener_count
    && signature[10] === payload?.reported_stream_count
    && signature[11] === payload?.stream_goal
    && signature[12] === payload?.host_account_id
    && signature[13] === payload?.host_handle
    && signature[14] === payload?.broadcast_start_time
    && signature[15] === metadata.description
    && signature[16] === metadata.artist_name
    && signature[17] === metadata.accent_color
    && signature[18] === images.medium?.url
    && signature[19] === images.logo?.medium?.url
    && signature[20] === currentStation.status
    && signature[21] === owner.thumbnail?.url
    && signature[22] === owner.medium?.url;
}

function captureSnapshotSignature(payload) {
  const metadata = payload?.metadata || {};
  const images = metadata.images || {};
  const currentStation = metadata.current_station || {};
  const owner = currentStation.owner || {};
  return [
    payload?.channel_id,
    payload?.station_id,
    payload?.is_launched,
    payload?.is_broadcasting,
    payload?.chat_status,
    payload?.listener_count,
    payload?.online_member_count,
    payload?.total_member_count,
    payload?.guest_count,
    payload?.cumulative_listener_count,
    payload?.reported_stream_count,
    payload?.stream_goal,
    payload?.host_account_id,
    payload?.host_handle,
    payload?.broadcast_start_time,
    metadata.description,
    metadata.artist_name,
    metadata.accent_color,
    images.medium?.url,
    images.logo?.medium?.url,
    currentStation.status,
    owner.thumbnail?.url,
    owner.medium?.url,
  ];
}

export function reportedStreamCount(data) {
  const value = num(data?.current_stream_count);
  return value != null && value >= 0 ? value : null;
}

export async function saveLeanSnapshot(db, observedAt, data) {
  const channelId = num(data?.channel_id);
  const stationId = num(data?.station_id);
  const channelKey = String(channelId ?? `station:${stationId ?? 0}`);
  const current = await db.prepare(`SELECT payload_hash,last_snapshot_at
    FROM sh_snapshot_current WHERE channel_key=?`).bind(channelKey).first();
  const streamCount = reportedStreamCount(data);
  const compactPayload = snapshotRawPayload(data);
  const hashPayload = snapshotHashPayload(data, streamCount, compactPayload);
  const hashCache = snapshotHashCacheFor(channelKey);
  const cacheHit = snapshotSignatureMatches(hashCache.signature, hashPayload);
  const hash = cacheHit ? hashCache.hash : await payloadHash(hashPayload);
  if (!cacheHit) {
    hashCache.signature = captureSnapshotSignature(hashPayload);
    hashCache.hash = hash;
  }
  if (current?.payload_hash === hash
      && observedAt - Number(current.last_snapshot_at || 0) < SNAPSHOT_CHECKPOINT_MS) {
    return {
      inserted: false,
      skipped: true,
      reportedStreamCount: streamCount,
      reported_stream_count: streamCount,
    };
  }

  const common = [
    observedAt, channelId, text(data?.channel_alias), text(data?.channel_name), stationId,
    bool(data?.is_launched), bool(data?.is_broadcasting), text(data?.chat_status),
    num(data?.listener_count), num(data?.online_member_count), num(data?.total_member_count),
    num(data?.guest_count), num(data?.total_listens), num(data?.stream_goal),
    streamCount, null, num(data?.host_account_id), text(data?.host_handle),
    num(data?.broadcast_start_time),
  ];
  const velocityBinds = [stationId, observedAt - 120_000, observedAt];
  const compactRaw = rawJson(compactPayload);

  await db.batch([
    db.prepare(`INSERT INTO sh_channel_snapshots (
      observed_at,channel_id,channel_alias,channel_name,station_id,
      is_launched,is_broadcasting,chat_status,listener_count,online_member_count,
      total_member_count,guest_count,total_listens,stream_goal,current_stream_count,
      validated_stream_count,host_account_id,host_handle,broadcast_start_time,comment_velocity,raw_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,(
      SELECT COALESCE(SUM(comment_count),0) FROM sh_comment_minute_counts
      WHERE station_id=? AND bucket_start>=? AND bucket_start<=?
    ),?)`).bind(...common, ...velocityBinds, compactRaw),
    db.prepare(`INSERT INTO sh_snapshot_current(
        channel_key,payload_hash,last_snapshot_at,last_stream_count,last_stream_at,updated_at
      ) VALUES(?,?,?,?,?,?) ON CONFLICT(channel_key) DO UPDATE SET
      payload_hash=excluded.payload_hash,last_snapshot_at=excluded.last_snapshot_at,
      last_stream_count=NULL,last_stream_at=NULL,
      updated_at=excluded.updated_at
      WHERE excluded.last_snapshot_at>=COALESCE(sh_snapshot_current.last_snapshot_at,0)`)
      .bind(
        channelKey,
        hash,
        observedAt,
        null,
        null,
        Date.now(),
      ),
  ]);
  return {
    inserted: true,
    skipped: false,
    reportedStreamCount: streamCount,
    reported_stream_count: streamCount,
  };
}

export function queueStructuralPayload(data) {
  if (data?.[QUEUE_STRUCTURAL_PAYLOAD]) return data[QUEUE_STRUCTURAL_PAYLOAD];
  return {
    station_id: num(data?.station_id),
    queue_id: num(data?.queue_id),
    start_time: num(data?.start_time),
    is_paused: bool(data?.is_paused),
    tracks: (Array.isArray(data?.tracks) ? data.tracks : []).map((track) => ({
      position: num(track?.position),
      queue_track_id: num(track?.queue_track_id),
      stationhead_track_id: num(track?.stationhead_track_id),
      spotify_id: text(track?.spotify_id),
      deezer_id: text(track?.deezer_id),
      isrc: text(track?.isrc),
      duration_ms: num(track?.duration_ms),
      preview_url: text(track?.preview_url),
    })),
  };
}

export function normalizedTrackIsrc(track) {
  const isrc = text(track?.isrc)?.trim().toUpperCase();
  return isrc || null;
}

export function normalizedTrackSpotifyId(track) {
  const spotifyId = text(track?.spotify_id)?.trim();
  return spotifyId || null;
}

export function legacyObservationTrackKey(track) {
  return normalizedTrackIsrc(track) || normalizedTrackSpotifyId(track);
}

export function observationTrackKey(track) {
  const isrc = normalizedTrackIsrc(track);
  if (isrc) return `isrc:${isrc}`;
  const spotifyId = normalizedTrackSpotifyId(track);
  return spotifyId ? `spotify:${spotifyId}` : null;
}

export function observationTrackKeys(track) {
  const key = observationTrackKey(track);
  return key ? [key] : [];
}

function latestRowsByIdentity(latestRows) {
  const rows = new Map();
  for (const row of latestRows || []) {
    const identity = observationTrackKey(row);
    if (!identity) continue;
    const previous = rows.get(identity);
    if (!previous || Number(row?.observed_at || 0) >= Number(previous?.observed_at || 0)) {
      rows.set(identity, row);
    }
  }
  return rows;
}

function structuralItemState(track, queueId = null) {
  return {
    queue_id: num(queueId ?? track?.queue_id),
    queue_track_id: num(track?.queue_track_id),
    stationhead_track_id: num(track?.stationhead_track_id),
    spotify_id: text(track?.spotify_id),
    deezer_id: text(track?.deezer_id),
    isrc: text(track?.isrc),
    duration_ms: num(track?.duration_ms),
    preview_url: text(track?.preview_url),
  };
}

function sameValue(left, right) {
  return (left ?? null) === (right ?? null);
}

export function queueItemsToWriteLean(tracks, existingRows, queueId = null) {
  const existing = new Map((existingRows || []).map((row) => [Number(row.position), row]));
  const unique = new Map();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const position = num(track?.position);
    if (position != null) unique.set(position, track);
  }
  const changed = [];
  for (const track of unique.values()) {
    const previous = existing.get(num(track.position));
    if (!previous) {
      changed.push(track);
      continue;
    }
    const current = structuralItemState(track, queueId);
    if (Object.entries(current).some(([key, value]) => !sameValue(previous[key], value))) changed.push(track);
  }
  return changed;
}

export function planLikeObservations(tracks, latestRows) {
  return planLikeChanges(tracks, latestRows).observations;
}

export function planLikeCurrentMigrations(tracks, latestRows) {
  return planLikeChanges(tracks, latestRows).currentLikeMigrations;
}

export function planLikeChanges(tracks, latestRows) {
  const latest = latestRowsByIdentity(latestRows);
  const unique = new Map();
  const migrations = [];
  const seen = new Set();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const canonical = observationTrackKey(track);
    const likeCount = num(track?.bite_count);
    if (!canonical || likeCount == null) continue;
    unique.set(canonical, track);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const row = latest.get(canonical);
    if (row && String(row.track_key || '') !== canonical
        && num(row.like_count) === likeCount) {
      migrations.push({ trackKey: canonical, track });
    }
  }
  const observations = [...unique.entries()]
    .filter(([identity, track]) => num(latest.get(identity)?.like_count) !== num(track.bite_count))
    .map(([trackKey, track]) => ({ trackKey, track }));
  return { observations, currentLikeMigrations: migrations };
}
