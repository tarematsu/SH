import { bool, num, rawJson, stripAppleMusicFields, text } from './api-utils.js';
import { prepared, runPreparedD1Batches } from './d1-batch.js';
import {
  normalizedTrackIsrc,
  observationTrackKey,
  planLikeCurrentMigrations,
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
export { splitD1Batches } from './d1-batch.js';

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function canBindInSingleStatement(baseBindCount, values) {
  return baseBindCount + (Array.isArray(values) ? values.length : 0) <= D1_SINGLE_STATEMENT_VARIABLE_LIMIT;
}

async function runPreparedBatches(db, statements, fallbackMethod = 'run') {
  return runPreparedD1Batches(db, statements, {
    variableLimit: D1_BATCH_VARIABLE_LIMIT,
    statementLimit: D1_BATCH_STATEMENT_LIMIT,
    fallbackMethod,
  });
}

async function runBatches(db, statements) {
  await runPreparedBatches(db, statements, 'run');
}

export function queueLikesPayload(tracks) {
  const unique = new Map();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const trackKey = observationTrackKey(track);
    const likeCount = num(track?.bite_count);
    if (!trackKey || likeCount == null) continue;
    unique.set(trackKey, likeCount);
  }
  return [...unique.entries()]
    .map(([trackKey, likeCount]) => ({ track_key: trackKey, like_count: likeCount }))
    .sort((left, right) => left.track_key.localeCompare(right.track_key));
}

export function hasCompleteLikeSnapshot(tracks) {
  const identifiable = (Array.isArray(tracks) ? tracks : [])
    .filter((track) => normalizedTrackIsrc(track));
  return identifiable.length === 0
    || identifiable.every((track) => num(track?.bite_count) != null);
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
      spotify_id,deezer_id,isrc,duration_ms,preview_url,observed_at
      FROM sh_queue_items
      WHERE station_id IS ? AND start_time IS ? AND position IN (${placeholders})`)
      .bind(stationId, startTime, ...group), 2 + group.length);
  });
}

function latestLikeLookupStatements(db, stationId, isrcs) {
  return chunks(isrcs, QUERY_CHUNK).filter((group) => group.length).map((group) => {
    const placeholders = group.map(() => '?').join(',');
    return prepared(db.prepare(`SELECT track_key,observed_at,like_count,
      queue_track_id,stationhead_track_id,spotify_id,isrc
      FROM sh_track_like_current
      WHERE station_id IS ? AND UPPER(isrc) IN (${placeholders})`)
      .bind(stationId, ...group), 1 + group.length);
  });
}

async function loadComparisonState(db, stationId, startTime, positions, likeIsrcs, options) {
  const itemStatements = options.includeItems
    ? queueItemLookupStatements(db, stationId, startTime, positions)
    : [];
  const likeStatements = options.includeLikes
    ? latestLikeLookupStatements(db, stationId, likeIsrcs)
    : [];
  const statements = itemStatements.concat(likeStatements);
  if (!statements.length) return { existingRows: [], latestRows: [] };
  const results = await runPreparedBatches(db, statements, 'all');
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
      preview_url=excluded.preview_url,raw_json=excluded.raw_json
    WHERE excluded.observed_at>=COALESCE((
      SELECT MAX(snapshot.observed_at) FROM sh_queue_snapshots snapshot
      WHERE snapshot.station_id IS excluded.station_id
        AND snapshot.start_time IS excluded.start_time
    ),sh_queue_items.observed_at)`)
    .bind(
      observedAt, stationId, queueId, startTime, num(track?.position),
      num(track?.queue_track_id), num(track?.stationhead_track_id),
      text(track?.spotify_id), text(track?.deezer_id), text(track?.isrc),
      num(track?.duration_ms), text(track?.preview_url),
      num(track?.bite_count), compactQueueItemRaw(track, queueId),
    ), 14));
}

function queueItemLikeUpdateStatements(db, tracks, observedAt, stationId, startTime) {
  return (Array.isArray(tracks) ? tracks : [])
    .filter((track) => num(track?.position) != null && num(track?.bite_count) != null)
    .map((track) => prepared(db.prepare(`UPDATE sh_queue_items
      SET bite_count=?
      WHERE station_id IS ? AND start_time IS ? AND position IS ?
        AND bite_count IS NOT ?
        AND ?>=COALESCE((
          SELECT MAX(snapshot.observed_at) FROM sh_queue_snapshots snapshot
          WHERE snapshot.station_id IS ? AND snapshot.start_time IS ?
        ),0)`).bind(
      num(track?.bite_count),
      stationId,
      startTime,
      num(track?.position),
      num(track?.bite_count),
      observedAt,
      stationId,
      startTime,
    ), 8));
}

function likeCurrentStatement(db, entry, observedAt, stationId, queueId, startTime) {
  const { trackKey, track } = entry;
  return prepared(db.prepare(`INSERT INTO sh_track_like_current (
      station_id,track_key,queue_id,start_time,position,queue_track_id,
      stationhead_track_id,spotify_id,isrc,like_count,observed_at
    ) SELECT ?,?,?,?,?,?,?,?,?,?,?
    WHERE ?>=COALESCE((
      SELECT MAX(snapshot.observed_at) FROM sh_queue_snapshots snapshot
      WHERE snapshot.station_id IS ?
    ),0)
    ON CONFLICT(station_id,track_key) DO UPDATE SET
      queue_id=excluded.queue_id,start_time=excluded.start_time,position=excluded.position,
      queue_track_id=excluded.queue_track_id,stationhead_track_id=excluded.stationhead_track_id,
      spotify_id=excluded.spotify_id,apple_music_id=NULL,isrc=excluded.isrc,
      like_count=excluded.like_count,observed_at=excluded.observed_at
    WHERE excluded.observed_at>=sh_track_like_current.observed_at
      AND excluded.like_count IS NOT sh_track_like_current.like_count`)
    .bind(
      stationId, trackKey, queueId, startTime, num(track?.position),
      num(track?.queue_track_id), num(track?.stationhead_track_id),
      text(track?.spotify_id), normalizedTrackIsrc(track), num(track?.bite_count), observedAt,
      observedAt, stationId,
    ), 13);
}

function likeCurrentMigrationStatements(db, migrations, observedAt, stationId, queueId, startTime) {
  return migrations.map((entry) => likeCurrentStatement(
    db,
    entry,
    observedAt,
    stationId,
    queueId,
    startTime,
  ));
}

function likeWriteStatements(db, observations, observedAt, stationId, queueId, startTime) {
  return observations.flatMap((entry) => {
    const { trackKey, track } = entry;
    return [
      likeCurrentStatement(db, entry, observedAt, stationId, queueId, startTime),
      prepared(db.prepare(`INSERT INTO sh_track_like_observations (
        observed_at,station_id,queue_id,start_time,position,
        queue_track_id,stationhead_track_id,spotify_id,isrc,
        track_key,like_count,source,raw_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        observedAt, stationId, queueId, startTime, num(track?.position),
        num(track?.queue_track_id), num(track?.stationhead_track_id),
        text(track?.spotify_id), normalizedTrackIsrc(track),
        trackKey, num(track?.bite_count), 'collector', rawJson({ bite_count: num(track?.bite_count) }),
      ), 13),
    ];
  });
}

function queueCurrentStatement(db, values) {
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
    .bind(...values), values.length);
}

function deleteMissingQueueItemsStatements(db, stationId, startTime, positions, observedAt) {
  if (!positions.length) {
    return [prepared(db.prepare(`DELETE FROM sh_queue_items
      WHERE station_id IS ? AND start_time IS ?
        AND ?>=COALESCE((
          SELECT MAX(snapshot.observed_at) FROM sh_queue_snapshots snapshot
          WHERE snapshot.station_id IS ? AND snapshot.start_time IS ?
        ),0)`).bind(stationId, startTime, observedAt, stationId, startTime), 5)];
  }
  if (!canBindInSingleStatement(5, positions)) return [];
  const placeholders = positions.map(() => '?').join(',');
  return [prepared(db.prepare(`DELETE FROM sh_queue_items
    WHERE station_id IS ? AND start_time IS ? AND position NOT IN (${placeholders})
      AND ?>=COALESCE((
        SELECT MAX(snapshot.observed_at) FROM sh_queue_snapshots snapshot
        WHERE snapshot.station_id IS ? AND snapshot.start_time IS ?
      ),0)`)
    .bind(stationId, startTime, ...positions, observedAt, stationId, startTime), 5 + positions.length)];
}

function deleteMissingCurrentLikesStatements(db, stationId, trackKeys, observedAt) {
  if (!trackKeys.length) {
    return [prepared(db.prepare(`DELETE FROM sh_track_like_current
      WHERE station_id IS ?
        AND ?>=COALESCE((
          SELECT MAX(snapshot.observed_at) FROM sh_queue_snapshots snapshot
          WHERE snapshot.station_id IS ?
        ),0)`).bind(stationId, observedAt, stationId), 3)];
  }
  if (!canBindInSingleStatement(3, trackKeys)) return [];
  const placeholders = trackKeys.map(() => '?').join(',');
  return [prepared(db.prepare(`DELETE FROM sh_track_like_current
    WHERE station_id IS ? AND track_key NOT IN (${placeholders})
      AND ?>=COALESCE((
        SELECT MAX(snapshot.observed_at) FROM sh_queue_snapshots snapshot
        WHERE snapshot.station_id IS ?
      ),0)`)
    .bind(stationId, ...trackKeys, observedAt, stationId), 3 + trackKeys.length)];
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

  const current = await db.prepare(`SELECT current.structural_hash,current.likes_hash,
      current.start_time,current.observed_at,
      COALESCE((
        SELECT MAX(snapshot.observed_at) FROM sh_queue_snapshots snapshot
        WHERE snapshot.station_id IS current.station_id
      ),0) AS latest_reachability_at
    FROM sh_queue_current current WHERE current.station_id IS ?`).bind(stationId).first();
  const currentWatermark = Math.max(
    num(current?.observed_at) ?? 0,
    num(current?.latest_reachability_at) ?? 0,
  );
  const staleCurrent = currentWatermark > 0 && observedAt < currentWatermark;
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
      currentLikeMigrationsWritten: 0,
      structureChanged: false,
      likesChanged: false,
      staleCurrent,
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
      return {
        claim,
        inspected: false,
        itemsWritten: 0,
        observationsWritten: 0,
        currentLikeMigrationsWritten: 0,
        staleCurrent,
      };
    }
  }

  const positions = [...new Set(tracks
    .map((track) => num(track?.position))
    .filter((value) => value != null))];
  const currentTrackKeys = completeLikes
    ? [...new Set(tracks.map(observationTrackKey).filter(Boolean))]
    : [];
  const lookupIsrcs = completeLikes
    ? [...new Set(tracks.map(normalizedTrackIsrc).filter(Boolean))]
    : [];
  const { existingRows, latestRows } = await loadComparisonState(
    db,
    stationId,
    startTime,
    positions,
    lookupIsrcs,
    { includeItems: structureChanged, includeLikes: likesChanged },
  );
  const changedTracks = structureChanged
    ? queueItemsToWriteLean(tracks, existingRows, queueId)
    : [];
  const observations = likesChanged ? planLikeObservations(tracks, latestRows) : [];
  const currentLikeMigrations = likesChanged
    ? planLikeCurrentMigrations(tracks, latestRows)
    : [];

  const statements = [];
  if (structureChanged && !staleCurrent) {
    statements.push(...deleteMissingQueueItemsStatements(
      db,
      stationId,
      startTime,
      positions,
      observedAt,
    ));
  }
  if (likesChanged && !staleCurrent) {
    statements.push(...deleteMissingCurrentLikesStatements(
      db,
      stationId,
      currentTrackKeys,
      observedAt,
    ));
    statements.push(...queueItemLikeUpdateStatements(
      db,
      tracks,
      observedAt,
      stationId,
      startTime,
    ));
    statements.push(...likeCurrentMigrationStatements(
      db,
      currentLikeMigrations,
      observedAt,
      stationId,
      queueId,
      startTime,
    ));
  }
  statements.push(
    ...queueItemWriteStatements(db, changedTracks, observedAt, stationId, queueId, startTime),
    ...likeWriteStatements(db, observations, observedAt, stationId, queueId, startTime),
  );
  if (!staleCurrent) {
    statements.push(queueCurrentStatement(db, [
      stationId, queueId, startTime, structuralHash, likesHash,
      bool(data?.is_paused), observedAt, Date.now(),
    ]));
  }
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
    currentLikeMigrationsWritten: staleCurrent ? 0 : currentLikeMigrations.length,
    structureChanged,
    likesChanged,
    staleCurrent,
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
    WHERE excluded.last_seen_at>=sh_collector_heartbeats.last_seen_at
      AND (
        excluded.last_seen_at-sh_collector_heartbeats.last_seen_at>=600000
        OR excluded.hostname IS NOT sh_collector_heartbeats.hostname
        OR excluded.version IS NOT sh_collector_heartbeats.version
        OR excluded.metadata_json IS NOT sh_collector_heartbeats.metadata_json
      )`)
    .bind(
      text(data?.collector_id), observedAt, observedAt,
      text(data?.hostname), text(data?.version), rawJson(stableHeartbeatMetadata(data)),
    ).run();
  return { accepted: Number(result?.meta?.changes || 0) > 0 };
}
