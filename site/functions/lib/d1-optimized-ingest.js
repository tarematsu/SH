import { bool, num, rawJson, stripAppleMusicFields, text } from './api-utils.js';
import {
  planLikeObservations,
  queueItemsToWriteLean,
  queueStructuralPayload,
  saveLeanSnapshot,
} from './d1-lean-ingest.js';
import { claimWrite, payloadHash, sourceIdentity } from './ingest-claim.js';

const QUERY_CHUNK = 80;
export const D1_BATCH_STATEMENT_LIMIT = 40;
export const D1_BATCH_VARIABLE_LIMIT = 90;
export const D1_SINGLE_STATEMENT_VARIABLE_LIMIT = 90;

export { saveLeanSnapshot };

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function prepared(statement, bindCount) {
  return { statement, bindCount };
}

function unwrapStatement(entry) {
  return entry?.statement || entry;
}

function canBindInSingleStatement(baseBindCount, values) {
  return baseBindCount + (Array.isArray(values) ? values.length : 0) <= D1_SINGLE_STATEMENT_VARIABLE_LIMIT;
}

function statementBindCount(entry) {
  if (Number.isFinite(entry?.bindCount)) return entry.bindCount;
  if (Array.isArray(entry?.params)) return entry.params.length;
  if (Array.isArray(entry?.statement?.params)) return entry.statement.params.length;
  return D1_SINGLE_STATEMENT_VARIABLE_LIMIT;
}

export function splitD1Batches(statements) {
  const groups = [];
  let current = [];
  let bindCount = 0;
  for (const statement of Array.isArray(statements) ? statements : []) {
    const nextBindCount = statementBindCount(statement);
    if (current.length > 0 && (
      current.length >= D1_BATCH_STATEMENT_LIMIT
      || bindCount + nextBindCount > D1_BATCH_VARIABLE_LIMIT
    )) {
      groups.push(current);
      current = [];
      bindCount = 0;
    }
    current.push(statement);
    bindCount += nextBindCount;
  }
  if (current.length) groups.push(current);
  return groups;
}

async function runBatches(db, statements) {
  for (const group of splitD1Batches(statements)) {
    if (group.length) await db.batch(group.map(unwrapStatement));
  }
}

function observationTrackKey(track) {
  return text(track?.queue_track_id)
    || text(track?.stationhead_track_id)
    || text(track?.spotify_id)
    || text(track?.isrc)
    || `position:${num(track?.position) ?? -1}`;
}

export function queueLikesPayload(tracks) {
  const unique = new Map();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const likeCount = num(track?.bite_count);
    if (likeCount == null) continue;
    unique.set(observationTrackKey(track), likeCount);
  }
  return [...unique.entries()]
    .map(([trackKey, likeCount]) => ({ track_key: trackKey, like_count: likeCount }))
    .sort((left, right) => left.track_key.localeCompare(right.track_key));
}

export function hasCompleteLikeSnapshot(tracks) {
  const values = Array.isArray(tracks) ? tracks : [];
  return values.length === 0 || values.every((track) => num(track?.bite_count) != null);
}

function compactQueueItemRaw(track, queueId) {
  return rawJson({
    queue_id: num(queueId ?? track?.queue_id),
    queue_track_id: num(track?.queue_track_id),
    stationhead_track_id: num(track?.stationhead_track_id),
    spotify_id: text(track?.spotify_id),
    deezer_id: text(track?.deezer_id),
    isrc: text(track?.isrc),
    duration_ms: num(track?.duration_ms),
    preview_url: text(track?.preview_url),
  });
}

function queueItemLookupStatements(db, stationId, startTime, positions) {
  return chunks(positions, QUERY_CHUNK).filter((group) => group.length).map((group) => {
    const placeholders = group.map(() => '?').join(',');
    return prepared(db.prepare(`SELECT position,queue_id,queue_track_id,stationhead_track_id,
      spotify_id,deezer_id,isrc,duration_ms,preview_url
      FROM sh_queue_items
      WHERE station_id IS ? AND start_time IS ? AND position IN (${placeholders})`)
      .bind(stationId, startTime, ...group), 2 + group.length);
  });
}

function latestLikeLookupStatements(db, stationId, trackKeys) {
  return chunks(trackKeys, QUERY_CHUNK).filter((group) => group.length).map((group) => {
    const placeholders = group.map(() => '?').join(',');
    return prepared(db.prepare(`SELECT track_key,observed_at,like_count
      FROM sh_track_like_current
      WHERE station_id IS ? AND track_key IN (${placeholders})`)
      .bind(stationId, ...group), 1 + group.length);
  });
}

async function loadComparisonState(db, stationId, startTime, positions, trackKeys, options) {
  const itemStatements = options.includeItems
    ? queueItemLookupStatements(db, stationId, startTime, positions)
    : [];
  const likeStatements = options.includeLikes
    ? latestLikeLookupStatements(db, stationId, trackKeys)
    : [];
  const statements = itemStatements.concat(likeStatements);
  if (!statements.length) return { existingRows: [], latestRows: [] };
  const results = typeof db.batch === 'function'
    ? await db.batch(statements.map(unwrapStatement))
    : await Promise.all(statements.map((statement) => unwrapStatement(statement).all()));
  return {
    existingRows: results.slice(0, itemStatements.length).flatMap((result) => result?.results || []),
    latestRows: results.slice(itemStatements.length).flatMap((result) => result?.results || []),
  };
}

function queueItemWriteStatements(db, tracks, observedAt, stationId, queueId, startTime) {
  return tracks.map((track) => prepared(db.prepare(`INSERT INTO sh_queue_items (
      observed_at,station_id,queue_id,start_time,position,
      queue_track_id,stationhead_track_id,spotify_id,
      deezer_id,isrc,duration_ms,preview_url,bite_count,raw_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(station_id,start_time,position) DO UPDATE SET
      observed_at=excluded.observed_at,queue_id=excluded.queue_id,
      queue_track_id=excluded.queue_track_id,stationhead_track_id=excluded.stationhead_track_id,
      spotify_id=excluded.spotify_id,apple_music_id=NULL,
      deezer_id=excluded.deezer_id,isrc=excluded.isrc,duration_ms=excluded.duration_ms,
      preview_url=excluded.preview_url,raw_json=excluded.raw_json`)
    .bind(
      observedAt, stationId, queueId, startTime, num(track?.position),
      num(track?.queue_track_id), num(track?.stationhead_track_id),
      text(track?.spotify_id), text(track?.deezer_id), text(track?.isrc),
      num(track?.duration_ms), text(track?.preview_url),
      num(track?.bite_count), compactQueueItemRaw(track, queueId),
    ), 14));
}

function likeWriteStatements(db, observations, observedAt, stationId, queueId, startTime) {
  return observations.flatMap(({ trackKey, track }) => [
    prepared(db.prepare(`INSERT INTO sh_track_like_current (
      station_id,track_key,queue_id,start_time,position,queue_track_id,
      stationhead_track_id,spotify_id,isrc,like_count,observed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(station_id,track_key) DO UPDATE SET
      queue_id=excluded.queue_id,start_time=excluded.start_time,position=excluded.position,
      queue_track_id=excluded.queue_track_id,stationhead_track_id=excluded.stationhead_track_id,
      spotify_id=excluded.spotify_id,apple_music_id=NULL,isrc=excluded.isrc,
      like_count=excluded.like_count,observed_at=excluded.observed_at
    WHERE excluded.like_count IS NOT sh_track_like_current.like_count`)
      .bind(
        stationId, trackKey, queueId, startTime, num(track?.position),
        num(track?.queue_track_id), num(track?.stationhead_track_id),
        text(track?.spotify_id), text(track?.isrc), num(track?.bite_count), observedAt,
      ), 11),
    prepared(db.prepare(`INSERT INTO sh_track_like_observations (
      observed_at,station_id,queue_id,start_time,position,
      queue_track_id,stationhead_track_id,spotify_id,isrc,
      track_key,like_count,source,raw_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      observedAt, stationId, queueId, startTime, num(track?.position),
      num(track?.queue_track_id), num(track?.stationhead_track_id),
      text(track?.spotify_id), text(track?.isrc),
      trackKey, num(track?.bite_count), 'collector', rawJson({ bite_count: num(track?.bite_count) }),
    ), 13),
  ]);
}

function queueCurrentStatement(db, values) {
  return prepared(db.prepare(`INSERT INTO sh_queue_current(
      station_id,queue_id,start_time,structural_hash,likes_hash,is_paused,observed_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(station_id) DO UPDATE SET
      queue_id=excluded.queue_id,start_time=excluded.start_time,
      structural_hash=excluded.structural_hash,likes_hash=excluded.likes_hash,
      is_paused=excluded.is_paused,observed_at=excluded.observed_at,
      updated_at=excluded.updated_at
    WHERE excluded.structural_hash IS NOT sh_queue_current.structural_hash
       OR excluded.likes_hash IS NOT sh_queue_current.likes_hash
       OR excluded.queue_id IS NOT sh_queue_current.queue_id
       OR excluded.start_time IS NOT sh_queue_current.start_time
       OR excluded.is_paused IS NOT sh_queue_current.is_paused`)
    .bind(...values), values.length);
}

function deleteMissingQueueItemsStatements(db, stationId, startTime, positions) {
  if (!positions.length) {
    return [prepared(db.prepare(`DELETE FROM sh_queue_items
      WHERE station_id IS ? AND start_time IS ?`).bind(stationId, startTime), 2)];
  }
  if (!canBindInSingleStatement(2, positions)) return [];
  const placeholders = positions.map(() => '?').join(',');
  return [prepared(db.prepare(`DELETE FROM sh_queue_items
    WHERE station_id IS ? AND start_time IS ? AND position NOT IN (${placeholders})`)
    .bind(stationId, startTime, ...positions), 2 + positions.length)];
}

function deleteMissingCurrentLikesStatements(db, stationId, trackKeys) {
  if (!trackKeys.length) {
    return [prepared(db.prepare('DELETE FROM sh_track_like_current WHERE station_id IS ?').bind(stationId), 1)];
  }
  if (!canBindInSingleStatement(1, trackKeys)) return [];
  const placeholders = trackKeys.map(() => '?').join(',');
  return [prepared(db.prepare(`DELETE FROM sh_track_like_current
    WHERE station_id IS ? AND track_key NOT IN (${placeholders})`)
    .bind(stationId, ...trackKeys), 1 + trackKeys.length)];
}

export async function saveLeanQueue(db, observedAt, body) {
  const data = stripAppleMusicFields(body?.data ?? {});
  const structuralPayload = queueStructuralPayload(data);
  const structuralHash = await payloadHash(structuralPayload);
  const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
  const completeLikes = hasCompleteLikeSnapshot(tracks);
  const stationId = num(data?.station_id);
  const startTime = num(data?.start_time);
  const queueId = num(data?.queue_id);

  const current = await db.prepare(`SELECT structural_hash,likes_hash,start_time
    FROM sh_queue_current WHERE station_id IS ?`).bind(stationId).first();
  const likesHash = completeLikes
    ? await payloadHash(queueLikesPayload(tracks))
    : text(current?.likes_hash);
  const structureChanged = current?.structural_hash !== structuralHash;
  const likesChanged = completeLikes && current?.likes_hash !== likesHash;
  if (!structureChanged && !likesChanged) {
    return {
      claim: { accepted: false, duplicate: true, reason: 'same_queue_current', hash: structuralHash },
      inspected: false,
      itemsWritten: 0,
      observationsWritten: 0,
      structureChanged: false,
      likesChanged: false,
      completeLikes,
    };
  }

  let claim = { accepted: false, duplicate: true, reason: 'same_queue_current', hash: structuralHash };
  if (structureChanged) {
    const source = sourceIdentity(body, {
      collectorId: body?.collector_id,
      collectorKind: 'external',
      sourcePriority: 50,
    });
    claim = await claimWrite(db, {
      dedupeKey: `station:${stationId ?? 0}:queue:${startTime ?? 0}:hash:${structuralHash}`,
      dataType: 'queue',
      ...source,
      observedAt,
      hash: structuralHash,
      payload: structuralPayload,
      metadata: { station_id: stationId, start_time: startTime },
    });
    if (!claim.accepted && !claim.duplicate) {
      return { claim, inspected: false, itemsWritten: 0, observationsWritten: 0 };
    }
  }

  const positions = [...new Set(tracks
    .map((track) => num(track?.position))
    .filter((value) => value != null))];
  const trackKeys = completeLikes
    ? [...new Set(tracks.map(observationTrackKey))]
    : [];
  const { existingRows, latestRows } = await loadComparisonState(
    db,
    stationId,
    startTime,
    positions,
    trackKeys,
    { includeItems: structureChanged, includeLikes: likesChanged },
  );
  const changedTracks = structureChanged
    ? queueItemsToWriteLean(tracks, existingRows, queueId)
    : [];
  const observations = likesChanged ? planLikeObservations(tracks, latestRows) : [];

  const statements = [];
  if (structureChanged) {
    statements.push(...deleteMissingQueueItemsStatements(db, stationId, startTime, positions));
  }
  if (likesChanged) {
    statements.push(...deleteMissingCurrentLikesStatements(db, stationId, trackKeys));
  }
  statements.push(
    ...queueItemWriteStatements(db, changedTracks, observedAt, stationId, queueId, startTime),
    ...likeWriteStatements(db, observations, observedAt, stationId, queueId, startTime),
    queueCurrentStatement(db, [
      stationId, queueId, startTime, structuralHash, likesHash,
      bool(data?.is_paused), observedAt, Date.now(),
    ]),
  );
  if (structureChanged && claim.accepted) {
    statements.unshift(prepared(db.prepare(`INSERT INTO sh_queue_snapshots (
      observed_at,station_id,queue_id,start_time,is_paused,raw_json
    ) VALUES (?,?,?,?,?,?)`).bind(
      observedAt, stationId, queueId, startTime,
      bool(data?.is_paused), rawJson(structuralPayload),
    ), 6));
  }
  await runBatches(db, statements);
  return {
    claim,
    inspected: true,
    itemsWritten: changedTracks.length,
    observationsWritten: observations.length,
    structureChanged,
    likesChanged,
    completeLikes,
  };
}

function stableHeartbeatMetadata(data) {
  const metadata = { ...(data || {}) };
  for (const key of [
    'collector_id', 'hostname', 'version', 'observed_at', 'last_seen_at',
    'heartbeat_at', 'timestamp', 'sent_at', 'now',
  ]) delete metadata[key];
  return metadata;
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
      text(data?.hostname), text(data?.version), rawJson(stableHeartbeatMetadata(data)),
    ).run();
  return { accepted: Number(result?.meta?.changes || 0) > 0 };
}
