import { payloadHash } from './ingest-claim.js';
import { bool, num, rawJson, text } from './api-utils.js';

const SNAPSHOT_CHECKPOINT_MS = 5 * 60_000;
const STREAM_MIN_RISE_LIMIT = 50_000;
const STREAM_MIN_DROP_LIMIT = 10_000;
const STREAM_RISE_PER_MINUTE = 10_000;

function snapshotRawPayload(data) {
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

function snapshotHashPayload(data, validatedStreamCount, compactRaw) {
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
    validated_stream_count: validatedStreamCount,
    stream_goal: num(data?.stream_goal),
    host_account_id: num(data?.host_account_id),
    host_handle: text(data?.host_handle),
    broadcast_start_time: num(data?.broadcast_start_time),
    metadata: compactRaw,
  };
}

function streamCandidates(data) {
  return [...new Set([
    num(data?.current_stream_count),
    num(data?.total_listens),
  ].filter((value) => value != null && value >= 0))];
}

export function validatedStreamCount(data, current, observedAt) {
  const candidates = streamCandidates(data);
  if (!candidates.length) return null;

  const previous = num(current?.last_stream_count);
  if (previous == null) {
    if (candidates.length === 1) return candidates[0];
    const smallest = Math.min(...candidates);
    const largest = Math.max(...candidates);
    if (largest - smallest > Math.max(10_000, smallest * 10)) return largest;
    return candidates[0];
  }

  const lastAcceptedAt = Number(
    current?.last_stream_at
    ?? current?.last_snapshot_at
    ?? observedAt,
  );
  const elapsedMinutes = Math.max(1, (observedAt - lastAcceptedAt) / 60_000);
  const riseLimit = Math.max(
    STREAM_MIN_RISE_LIMIT,
    Math.abs(previous) * 0.5,
    elapsedMinutes * STREAM_RISE_PER_MINUTE,
  );
  const dropLimit = Math.max(STREAM_MIN_DROP_LIMIT, Math.abs(previous) * 0.1);
  const continuous = candidates.filter((value) => {
    const delta = value - previous;
    return delta <= riseLimit && delta >= -dropLimit;
  });
  if (!continuous.length) return null;
  continuous.sort((left, right) => Math.abs(left - previous) - Math.abs(right - previous));
  return continuous[0];
}

export async function saveLeanSnapshot(db, observedAt, data) {
  const channelId = num(data?.channel_id);
  const stationId = num(data?.station_id);
  const channelKey = String(channelId ?? `station:${stationId ?? 0}`);
  const current = await db.prepare(`SELECT payload_hash,last_snapshot_at,last_stream_count,last_stream_at
    FROM sh_snapshot_current WHERE channel_key=?`).bind(channelKey).first();
  const streamCount = validatedStreamCount(data, current, observedAt);
  const streamRejected = streamCount == null && streamCandidates(data).length > 0;
  const compactPayload = snapshotRawPayload(data);
  const hash = await payloadHash(snapshotHashPayload(data, streamCount, compactPayload));
  if (current?.payload_hash === hash
      && observedAt - Number(current.last_snapshot_at || 0) < SNAPSHOT_CHECKPOINT_MS) {
    return { inserted: false, skipped: true, streamRejected };
  }

  const common = [
    observedAt, channelId, text(data?.channel_alias), text(data?.channel_name), stationId,
    bool(data?.is_launched), bool(data?.is_broadcasting), text(data?.chat_status),
    num(data?.listener_count), num(data?.online_member_count), num(data?.total_member_count),
    num(data?.guest_count), num(data?.total_listens), num(data?.stream_goal),
    num(data?.current_stream_count), streamCount, num(data?.host_account_id), text(data?.host_handle),
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
      last_stream_count=COALESCE(excluded.last_stream_count,sh_snapshot_current.last_stream_count),
      last_stream_at=CASE WHEN excluded.last_stream_count IS NOT NULL
        THEN excluded.last_stream_at ELSE sh_snapshot_current.last_stream_at END,
      updated_at=excluded.updated_at
      WHERE excluded.last_snapshot_at>=COALESCE(sh_snapshot_current.last_snapshot_at,0)`)
      .bind(
        channelKey,
        hash,
        observedAt,
        streamCount,
        streamCount != null ? observedAt : null,
        Date.now(),
      ),
  ]);
  return { inserted: true, skipped: false, streamRejected };
}

export function queueStructuralPayload(data) {
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
  const latest = latestRowsByIdentity(latestRows);
  const unique = new Map();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const identity = observationTrackKey(track);
    if (!identity || num(track?.bite_count) == null) continue;
    unique.set(identity, track);
  }
  return [...unique.entries()]
    .filter(([identity, track]) => num(latest.get(identity)?.like_count) !== num(track.bite_count))
    .map(([trackKey, track]) => ({ trackKey, track }));
}

export function planLikeCurrentMigrations(tracks, latestRows) {
  const latest = latestRowsByIdentity(latestRows);
  const migrations = [];
  const seen = new Set();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const canonical = observationTrackKey(track);
    const likeCount = num(track?.bite_count);
    if (!canonical || likeCount == null || seen.has(canonical)) continue;
    seen.add(canonical);
    const row = latest.get(canonical);
    if (row && String(row.track_key || '') !== canonical
        && num(row.like_count) === likeCount) {
      migrations.push({ trackKey: canonical, track });
    }
  }
  return migrations;
}
