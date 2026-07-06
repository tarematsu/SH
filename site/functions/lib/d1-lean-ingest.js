import { claimWrite, payloadHash, sourceIdentity } from './ingest-claim.js';
import { bool, num, rawJson, text } from './api-utils.js';

const QUERY_CHUNK = 80;
const BATCH_CHUNK = 80;
const SNAPSHOT_CHECKPOINT_MS = 5 * 60_000;
const STREAM_MIN_RISE_LIMIT = 50_000;
const STREAM_MIN_DROP_LIMIT = 10_000;
const STREAM_RISE_PER_MINUTE = 10_000;

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function runBatches(db, statements) {
  for (const group of chunks(statements, BATCH_CHUNK)) {
    if (group.length) await db.batch(group);
  }
}

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
      updated_at=excluded.updated_at`)
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

function observationTrackKey(track) {
  return text(track?.queue_track_id)
    || text(track?.stationhead_track_id)
    || text(track?.spotify_id)
    || text(track?.isrc)
    || `position:${num(track?.position) ?? -1}`;
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

function queueItemLookupStatements(db, stationId, startTime, positions) {
  return chunks(positions, QUERY_CHUNK).filter((group) => group.length).map((group) => {
    const placeholders = group.map(() => '?').join(',');
    return db.prepare(`SELECT position,queue_id,queue_track_id,stationhead_track_id,
      spotify_id,deezer_id,isrc,duration_ms,preview_url
      FROM sh_queue_items
      WHERE station_id IS ? AND start_time IS ? AND position IN (${placeholders})`)
      .bind(stationId, startTime, ...group);
  });
}

function latestLikeLookupStatements(db, stationId, trackKeys) {
  return chunks(trackKeys, QUERY_CHUNK).filter((group) => group.length).map((group) => {
    const placeholders = group.map(() => '?').join(',');
    return db.prepare(`SELECT track_key,observed_at,like_count
      FROM sh_track_like_current
      WHERE station_id IS ? AND track_key IN (${placeholders})`)
      .bind(stationId, ...group);
  });
}

async function loadComparisonState(db, stationId, startTime, positions, trackKeys, includeItems) {
  const itemStatements = includeItems ? queueItemLookupStatements(db, stationId, startTime, positions) : [];
  const likeStatements = latestLikeLookupStatements(db, stationId, trackKeys);
  const statements = itemStatements.concat(likeStatements);
  if (!statements.length) return { existingRows: [], latestRows: [] };
  const results = typeof db.batch === 'function'
    ? await db.batch(statements)
    : await Promise.all(statements.map((statement) => statement.all()));
  return {
    existingRows: results.slice(0, itemStatements.length).flatMap((result) => result?.results || []),
    latestRows: results.slice(itemStatements.length).flatMap((result) => result?.results || []),
  };
}

export function planLikeObservations(tracks, latestRows) {
  const latest = new Map((latestRows || []).map((row) => [String(row.track_key), row]));
  const unique = new Map();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    if (num(track?.bite_count) == null) continue;
    unique.set(observationTrackKey(track), track);
  }
  return [...unique.entries()]
    .filter(([trackKey, track]) => num(latest.get(trackKey)?.like_count) !== num(track.bite_count))
    .map(([trackKey, track]) => ({ trackKey, track }));
}

function compactQueueItemRaw(track) {
  return rawJson(structuralItemState(track));
}

function queueItemWriteStatements(db, tracks, observedAt, stationId, queueId, startTime) {
  return tracks.map((track) => db.prepare(`INSERT INTO sh_queue_items (
      observed_at,station_id,queue_id,start_time,position,
      queue_track_id,stationhead_track_id,spotify_id,apple_music_id,
      deezer_id,isrc,duration_ms,preview_url,bite_count,raw_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(station_id,start_time,position) DO UPDATE SET
      observed_at=excluded.observed_at,queue_id=excluded.queue_id,
      queue_track_id=excluded.queue_track_id,stationhead_track_id=excluded.stationhead_track_id,
      spotify_id=excluded.spotify_id,apple_music_id=NULL,
      deezer_id=excluded.deezer_id,isrc=excluded.isrc,duration_ms=excluded.duration_ms,
      preview_url=excluded.preview_url,raw_json=excluded.raw_json`)
    .bind(
      observedAt, stationId, queueId, startTime, num(track?.position),
      num(track?.queue_track_id), num(track?.stationhead_track_id),
      text(track?.spotify_id), null, text(track?.deezer_id),
      text(track?.isrc), num(track?.duration_ms), text(track?.preview_url),
      num(track?.bite_count), compactQueueItemRaw(track),
    ));
}

function likeWriteStatements(db, observations, observedAt, stationId, queueId, startTime) {
  return observations.flatMap(({ trackKey, track }) => [
    db.prepare(`INSERT INTO sh_track_like_current (
      station_id,track_key,queue_id,start_time,position,queue_track_id,
      stationhead_track_id,spotify_id,apple_music_id,isrc,like_count,observed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(station_id,track_key) DO UPDATE SET
      queue_id=excluded.queue_id,start_time=excluded.start_time,position=excluded.position,
      queue_track_id=excluded.queue_track_id,stationhead_track_id=excluded.stationhead_track_id,
      spotify_id=excluded.spotify_id,apple_music_id=NULL,isrc=excluded.isrc,
      like_count=excluded.like_count,observed_at=excluded.observed_at`)
      .bind(
        stationId, trackKey, queueId, startTime, num(track?.position),
        num(track?.queue_track_id), num(track?.stationhead_track_id),
        text(track?.spotify_id), null, text(track?.isrc),
        num(track?.bite_count), observedAt,
      ),
    db.prepare(`INSERT INTO sh_track_like_observations (
      observed_at,station_id,queue_id,start_time,position,
      queue_track_id,stationhead_track_id,spotify_id,apple_music_id,isrc,
      track_key,like_count,source,raw_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      observedAt, stationId, queueId, startTime, num(track?.position),
      num(track?.queue_track_id), num(track?.stationhead_track_id),
      text(track?.spotify_id), null, text(track?.isrc),
      trackKey, num(track?.bite_count), 'collector', rawJson({ bite_count: num(track?.bite_count) }),
    ),
  ]);
}

export async function saveLeanQueue(db, observedAt, body) {
  const data = body?.data ?? {};
  const payload = queueStructuralPayload(data);
  const hash = await payloadHash(payload);
  const stationId = num(data?.station_id);
  const startTime = num(data?.start_time);
  const queueId = num(data?.queue_id);
  const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
  const current = await db.prepare(`SELECT structural_hash,start_time
    FROM sh_queue_current WHERE station_id IS ?`).bind(stationId).first();
  const structureChanged = current?.structural_hash !== hash;

  let claim = { accepted: false, duplicate: true, reason: 'same_queue_current', hash };
  if (structureChanged) {
    const source = sourceIdentity(body, {
      collectorId: body?.collector_id,
      collectorKind: 'external',
      sourcePriority: 50,
    });
    claim = await claimWrite(db, {
      dedupeKey: `station:${stationId ?? 0}:queue:${startTime ?? 0}:hash:${hash}`,
      dataType: 'queue', ...source, observedAt, hash, payload,
      metadata: { station_id: stationId, start_time: startTime },
    });
    if (!claim.accepted) return { claim, inspected: false, itemsWritten: 0, observationsWritten: 0 };
  }

  const positions = [...new Set(tracks.map((track) => num(track?.position)).filter((value) => value != null))];
  const trackKeys = [...new Set(tracks.filter((track) => num(track?.bite_count) != null).map(observationTrackKey))];
  const { existingRows, latestRows } = await loadComparisonState(
    db, stationId, startTime, positions, trackKeys, structureChanged,
  );
  const changedTracks = structureChanged ? queueItemsToWriteLean(tracks, existingRows, queueId) : [];
  const observations = planLikeObservations(tracks, latestRows);
  const statements = [
    ...queueItemWriteStatements(db, changedTracks, observedAt, stationId, queueId, startTime),
    ...likeWriteStatements(db, observations, observedAt, stationId, queueId, startTime),
  ];
  if (structureChanged) {
    statements.unshift(
      db.prepare(`INSERT INTO sh_queue_snapshots (
        observed_at,station_id,queue_id,start_time,is_paused,raw_json
      ) VALUES (?,?,?,?,?,?)`).bind(observedAt, stationId, queueId, startTime, bool(data?.is_paused), rawJson(payload)),
      db.prepare(`INSERT INTO sh_queue_current(
        station_id,queue_id,start_time,structural_hash,is_paused,observed_at,updated_at
      ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(station_id) DO UPDATE SET
        queue_id=excluded.queue_id,start_time=excluded.start_time,
        structural_hash=excluded.structural_hash,is_paused=excluded.is_paused,
        observed_at=excluded.observed_at,updated_at=excluded.updated_at`)
        .bind(stationId, queueId, startTime, hash, bool(data?.is_paused), observedAt, Date.now()),
    );
  }
  await runBatches(db, statements);
  return {
    claim, inspected: true, itemsWritten: changedTracks.length,
    observationsWritten: observations.length, structureChanged,
  };
}

export async function saveLeanHeartbeat(db, observedAt, data) {
  const result = await db.prepare(`INSERT INTO sh_collector_heartbeats (
      collector_id,first_seen_at,last_seen_at,hostname,version,metadata_json
    ) VALUES (?,?,?,?,?,?)
    ON CONFLICT(collector_id) DO UPDATE SET
      last_seen_at=excluded.last_seen_at,hostname=excluded.hostname,
      version=excluded.version,metadata_json=excluded.metadata_json
    WHERE excluded.last_seen_at-sh_collector_heartbeats.last_seen_at>=600000
       OR excluded.hostname IS NOT sh_collector_heartbeats.hostname
       OR excluded.version IS NOT sh_collector_heartbeats.version
       OR excluded.metadata_json IS NOT sh_collector_heartbeats.metadata_json`)
    .bind(
      text(data?.collector_id), observedAt, observedAt,
      text(data?.hostname), text(data?.version), rawJson(data),
    ).run();
  return { accepted: Number(result?.meta?.changes || 0) > 0 };
}
