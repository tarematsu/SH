import { bool, num, rawJson, text } from '../../site/functions/lib/api-utils.js';
import { prepared, runPreparedD1Batches } from '../../site/functions/lib/d1-batch.js';
import {
  normalizedTrackIsrc,
  normalizedTrackSpotifyId,
  queueItemsToWriteLean,
  queueStructuralPayload,
} from '../../site/functions/lib/d1-lean-ingest.js';
import { claimWrite, payloadHash, sourceIdentity } from '../../site/functions/lib/ingest-claim.js';

const QUERY_CHUNK = 80;
const VARIABLE_LIMIT = 90;
const STATEMENT_LIMIT = 40;
const ITEM_BIND_COUNT = 14;
const ITEM_WRITE_CHUNK = Math.max(1, Math.floor(VARIABLE_LIMIT / ITEM_BIND_COUNT));
const EMPTY_TRACKS = Object.freeze([]);

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function uniquePositions(tracks) {
  const seen = new Set();
  const positions = [];
  for (let index = 0; index < tracks.length; index += 1) {
    const position = num(tracks[index]?.position);
    if (position == null || seen.has(position)) continue;
    seen.add(position);
    positions.push(position);
  }
  return positions;
}

async function loadExistingItems(db, stationId, startTime, positions) {
  if (!positions.length) return [];
  const statements = [];
  for (const group of chunks(positions, QUERY_CHUNK)) {
    const placeholders = group.map(() => '?').join(',');
    statements.push(prepared(db.prepare(`SELECT position,queue_id,queue_track_id,stationhead_track_id,
      spotify_id,deezer_id,isrc,duration_ms,preview_url,observed_at
      FROM sh_queue_items
      WHERE station_id IS ? AND start_time IS ? AND position IN (${placeholders})`)
      .bind(stationId, startTime, ...group), 2 + group.length));
  }
  const results = await runPreparedD1Batches(db, statements, {
    variableLimit: VARIABLE_LIMIT,
    statementLimit: STATEMENT_LIMIT,
    fallbackMethod: 'all',
  });
  return results.flatMap((result) => result?.results || []);
}

function compactClaim(claim, structuralHash) {
  return {
    accepted: claim?.accepted === true,
    duplicate: claim?.duplicate === true,
    reason: claim?.reason || null,
    hash: claim?.hash || structuralHash,
  };
}

function claimNeedsSnapshot(claim, observedAt) {
  return claim?.accepted === true
    || (claim?.duplicate === true && num(claim?.existing?.observed_at) === observedAt);
}

export async function prepareQueueStructurePersistence(db, body, observedAt) {
  const data = body?.data || {};
  const structuralPayload = body?.analysis?.structural || queueStructuralPayload(data);
  const tracks = Array.isArray(structuralPayload?.tracks) ? structuralPayload.tracks : EMPTY_TRACKS;
  const stationId = num(data.station_id ?? structuralPayload?.station_id);
  const startTime = num(data.start_time ?? structuralPayload?.start_time);
  const queueId = num(data.queue_id ?? structuralPayload?.queue_id);
  const current = await db.prepare(`SELECT current.structural_hash,current.likes_hash,
      current.observed_at,COALESCE((
        SELECT MAX(snapshot.observed_at) FROM sh_queue_snapshots snapshot
        WHERE snapshot.station_id IS current.station_id
      ),0) AS latest_reachability_at
    FROM sh_queue_current current WHERE current.station_id IS ?`)
    .bind(stationId).first();
  const structuralHash = typeof body?.analysis?.structural_hash === 'string'
    ? body.analysis.structural_hash
    : await payloadHash(structuralPayload);
  const currentWatermark = Math.max(
    num(current?.observed_at) ?? 0,
    num(current?.latest_reachability_at) ?? 0,
  );
  const staleCurrent = currentWatermark > 0 && observedAt < currentWatermark;
  if (current?.structural_hash === structuralHash) {
    return {
      structure_changed: false,
      snapshot_required: false,
      stale_current: staleCurrent,
      station_id: stationId,
      queue_id: queueId,
      start_time: startTime,
      structural_hash: structuralHash,
      likes_hash: text(current?.likes_hash),
      all_positions: uniquePositions(tracks),
      write_positions: [],
      claim: compactClaim(null, structuralHash),
    };
  }

  const source = sourceIdentity(body, {
    collectorId: body?.collector_id,
    collectorKind: 'external',
    sourcePriority: 50,
  });
  const claim = await claimWrite(db, {
    dedupeKey: `station:${stationId ?? 0}:queue:${startTime ?? 0}:hash:${structuralHash}`,
    dataType: 'queue',
    ...source,
    observedAt,
    hash: structuralHash,
    payload: structuralPayload,
    metadata: { station_id: stationId, start_time: startTime },
  });
  if (!claim.accepted && !claim.duplicate) {
    return {
      structure_changed: false,
      snapshot_required: false,
      blocked: true,
      stale_current: staleCurrent,
      station_id: stationId,
      queue_id: queueId,
      start_time: startTime,
      structural_hash: structuralHash,
      likes_hash: text(current?.likes_hash),
      all_positions: [],
      write_positions: [],
      claim: compactClaim(claim, structuralHash),
    };
  }

  const positions = uniquePositions(tracks);
  const existingRows = await loadExistingItems(db, stationId, startTime, positions);
  const changedTracks = queueItemsToWriteLean(tracks, existingRows, queueId);
  return {
    structure_changed: true,
    snapshot_required: claimNeedsSnapshot(claim, observedAt),
    stale_current: staleCurrent,
    station_id: stationId,
    queue_id: queueId,
    start_time: startTime,
    structural_hash: structuralHash,
    likes_hash: text(current?.likes_hash),
    all_positions: positions,
    write_positions: uniquePositions(changedTracks),
    claim: compactClaim(claim, structuralHash),
  };
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

function itemValues(track, observedAt, plan) {
  return [
    observedAt,
    plan.station_id,
    plan.queue_id,
    plan.start_time,
    num(track?.position),
    num(track?.queue_track_id),
    num(track?.stationhead_track_id),
    normalizedTrackSpotifyId(track),
    text(track?.deezer_id),
    normalizedTrackIsrc(track),
    num(track?.duration_ms),
    text(track?.preview_url),
    null,
    compactQueueItemRaw(track, plan.queue_id),
  ];
}

function queueItemStatements(db, tracks, observedAt, plan) {
  const statements = [];
  for (const group of chunks(tracks, ITEM_WRITE_CHUNK)) {
    if (!group.length) continue;
    const valuesSql = group.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
    const binds = group.flatMap((track) => itemValues(track, observedAt, plan));
    statements.push(prepared(db.prepare(`INSERT INTO sh_queue_items (
        observed_at,station_id,queue_id,start_time,position,
        queue_track_id,stationhead_track_id,spotify_id,
        deezer_id,isrc,duration_ms,preview_url,bite_count,raw_json
      ) VALUES ${valuesSql}
      ON CONFLICT(station_id,start_time,position) DO UPDATE SET
        observed_at=excluded.observed_at,queue_id=excluded.queue_id,
        queue_track_id=excluded.queue_track_id,stationhead_track_id=excluded.stationhead_track_id,
        spotify_id=excluded.spotify_id,apple_music_id=NULL,
        deezer_id=excluded.deezer_id,isrc=excluded.isrc,duration_ms=excluded.duration_ms,
        preview_url=excluded.preview_url,raw_json=excluded.raw_json
      WHERE excluded.observed_at>=COALESCE((
        SELECT MAX(snapshot.observed_at) FROM sh_queue_snapshots snapshot
        WHERE snapshot.station_id IS excluded.station_id
          AND snapshot.start_time IS excluded.start_time
      ),sh_queue_items.observed_at)`)
      .bind(...binds), binds.length));
  }
  return statements;
}

function deleteMissingStatement(db, plan, observedAt) {
  const positions = Array.isArray(plan.all_positions) ? plan.all_positions : [];
  if (5 + positions.length > VARIABLE_LIMIT) return null;
  if (!positions.length) {
    return prepared(db.prepare(`DELETE FROM sh_queue_items
      WHERE station_id IS ? AND start_time IS ?
        AND ?>=COALESCE((
          SELECT MAX(snapshot.observed_at) FROM sh_queue_snapshots snapshot
          WHERE snapshot.station_id IS ? AND snapshot.start_time IS ?
        ),0)`).bind(
      plan.station_id,
      plan.start_time,
      observedAt,
      plan.station_id,
      plan.start_time,
    ), 5);
  }
  const placeholders = positions.map(() => '?').join(',');
  return prepared(db.prepare(`DELETE FROM sh_queue_items
    WHERE station_id IS ? AND start_time IS ? AND position NOT IN (${placeholders})
      AND ?>=COALESCE((
        SELECT MAX(snapshot.observed_at) FROM sh_queue_snapshots snapshot
        WHERE snapshot.station_id IS ? AND snapshot.start_time IS ?
      ),0)`)
    .bind(
      plan.station_id,
      plan.start_time,
      ...positions,
      observedAt,
      plan.station_id,
      plan.start_time,
    ), 5 + positions.length);
}

function queueCurrentStatement(db, data, plan, observedAt) {
  return prepared(db.prepare(`INSERT INTO sh_queue_current(
      station_id,queue_id,start_time,structural_hash,likes_hash,is_paused,observed_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(station_id) DO UPDATE SET
      queue_id=excluded.queue_id,start_time=excluded.start_time,
      structural_hash=excluded.structural_hash,likes_hash=excluded.likes_hash,
      is_paused=excluded.is_paused,observed_at=excluded.observed_at,
      updated_at=excluded.updated_at
    WHERE excluded.observed_at>=COALESCE((
      SELECT MAX(snapshot.observed_at) FROM sh_queue_snapshots snapshot
      WHERE snapshot.station_id IS excluded.station_id
    ),sh_queue_current.observed_at)
      AND (
        excluded.structural_hash IS NOT sh_queue_current.structural_hash
        OR excluded.likes_hash IS NOT sh_queue_current.likes_hash
        OR excluded.queue_id IS NOT sh_queue_current.queue_id
        OR excluded.start_time IS NOT sh_queue_current.start_time
        OR excluded.is_paused IS NOT sh_queue_current.is_paused
      )`)
    .bind(
      plan.station_id,
      plan.queue_id,
      plan.start_time,
      plan.structural_hash,
      plan.likes_hash,
      bool(data?.is_paused),
      observedAt,
      Date.now(),
    ), 8);
}

function queueSnapshotStatement(db, data, structuralPayload, observedAt, plan) {
  return prepared(db.prepare(`INSERT INTO sh_queue_snapshots (
      observed_at,station_id,queue_id,start_time,is_paused,raw_json
    ) SELECT ?,?,?,?,?,?
    WHERE NOT EXISTS (
      SELECT 1 FROM sh_queue_snapshots
      WHERE observed_at=? AND station_id IS ? AND queue_id IS ? AND start_time IS ?
      LIMIT 1
    )`).bind(
    observedAt,
    plan.station_id,
    plan.queue_id,
    plan.start_time,
    bool(data?.is_paused),
    rawJson(structuralPayload),
    observedAt,
    plan.station_id,
    plan.queue_id,
    plan.start_time,
  ), 10);
}

export async function commitQueueStructurePersistence(db, body, observedAt, plan) {
  if (!plan?.structure_changed || plan?.blocked) {
    return {
      claim: plan?.claim || null,
      inspected: false,
      itemsWritten: 0,
      observationsWritten: 0,
      currentLikeMigrationsWritten: 0,
      structureChanged: false,
      likesChanged: false,
      staleCurrent: plan?.stale_current === true,
    };
  }
  const data = body?.data || {};
  const structuralPayload = body?.analysis?.structural || queueStructuralPayload(data);
  const tracks = Array.isArray(structuralPayload?.tracks) ? structuralPayload.tracks : EMPTY_TRACKS;
  const writes = new Set(Array.isArray(plan.write_positions) ? plan.write_positions : []);
  const changedTracks = tracks.filter((track) => writes.has(num(track?.position)));
  const statements = [];
  if (!plan.stale_current) {
    const deleteMissing = deleteMissingStatement(db, plan, observedAt);
    if (deleteMissing) statements.push(deleteMissing);
  }
  statements.push(...queueItemStatements(db, changedTracks, observedAt, plan));
  if (!plan.stale_current) statements.push(queueCurrentStatement(db, data, plan, observedAt));
  if (plan.snapshot_required === true) {
    statements.unshift(queueSnapshotStatement(db, data, structuralPayload, observedAt, plan));
  }
  await runPreparedD1Batches(db, statements, {
    variableLimit: VARIABLE_LIMIT,
    statementLimit: STATEMENT_LIMIT,
    fallbackMethod: 'run',
  });
  return {
    claim: plan.claim,
    inspected: true,
    itemsWritten: changedTracks.length,
    observationsWritten: 0,
    currentLikeMigrationsWritten: 0,
    structureChanged: true,
    likesChanged: false,
    staleCurrent: plan.stale_current === true,
  };
}
