import { bool, num, rawJson, text } from './api-utils.js';
import { prepared, runPreparedD1Batches } from './d1-batch.js';
import {
  normalizedTrackIsrc,
  normalizedTrackSpotifyId,
  observationTrackKey,
  planLikeChanges,
  queueItemsToWriteLean,
  queueStructuralPayload,
  resetSnapshotHashCacheForTests,
  saveLeanSnapshot,
} from './d1-lean-ingest.js';
import { claimWrite, payloadHash, sourceIdentity } from './ingest-claim.js';

const QUERY_CHUNK = 80;
const QUEUE_LIKE_ANALYSIS = Symbol.for('stationhead.queue.like-analysis');
export const D1_BATCH_STATEMENT_LIMIT = 40;
export const D1_BATCH_VARIABLE_LIMIT = 90;
export const D1_SINGLE_STATEMENT_VARIABLE_LIMIT = 90;
const QUEUE_HASH_CACHE_LIMIT = 16;
const queueHashCache = new Map();

export function resetQueueHashCacheForTests() {
  queueHashCache.clear();
  resetSnapshotHashCacheForTests();
}

function queueHashCacheFor(stationId) {
  const key = String(stationId ?? 0);
  const existing = queueHashCache.get(key);
  if (existing) return existing;
  if (queueHashCache.size >= QUEUE_HASH_CACHE_LIMIT) {
    const oldest = queueHashCache.keys().next().value;
    if (oldest !== undefined) queueHashCache.delete(oldest);
  }
  const value = {};
  queueHashCache.set(key, value);
  return value;
}

function structuralSignatureMatches(signature, payload) {
  const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
  const expectedLength = 5 + tracks.length * 8;
  if (!signature || signature.length !== expectedLength) return false;

  let offset = 0;
  if (signature[offset++] !== payload.station_id
      || signature[offset++] !== payload.queue_id
      || signature[offset++] !== payload.start_time
      || signature[offset++] !== payload.is_paused
      || signature[offset++] !== tracks.length) {
    return false;
  }

  for (const track of tracks) {
    if (signature[offset++] !== track.position
        || signature[offset++] !== track.queue_track_id
        || signature[offset++] !== track.stationhead_track_id
        || signature[offset++] !== track.spotify_id
        || signature[offset++] !== track.deezer_id
        || signature[offset++] !== track.isrc
        || signature[offset++] !== track.duration_ms
        || signature[offset++] !== track.preview_url) {
      return false;
    }
  }
  return true;
}

function captureStructuralSignature(payload) {
  const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
  const signature = new Array(5 + tracks.length * 8);
  let offset = 0;
  signature[offset++] = payload.station_id;
  signature[offset++] = payload.queue_id;
  signature[offset++] = payload.start_time;
  signature[offset++] = payload.is_paused;
  signature[offset++] = tracks.length;
  for (const track of tracks) {
    signature[offset++] = track.position;
    signature[offset++] = track.queue_track_id;
    signature[offset++] = track.stationhead_track_id;
    signature[offset++] = track.spotify_id;
    signature[offset++] = track.deezer_id;
    signature[offset++] = track.isrc;
    signature[offset++] = track.duration_ms;
    signature[offset++] = track.preview_url;
  }
  return signature;
}

function likesSignatureMatches(signature, payload) {
  if (!signature || signature.length !== payload.length * 2) return false;
  let offset = 0;
  for (const like of payload) {
    if (signature[offset++] !== like.track_key
        || signature[offset++] !== like.like_count) {
      return false;
    }
  }
  return true;
}

function captureLikesSignature(payload) {
  const signature = new Array(payload.length * 2);
  let offset = 0;
  for (const like of payload) {
    signature[offset++] = like.track_key;
    signature[offset++] = like.like_count;
  }
  return signature;
}

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
  return analyzeQueueLikes(tracks).payload;
}

export function analyzeQueueLikes(tracks) {
  if (tracks?.[QUEUE_LIKE_ANALYSIS]) return tracks[QUEUE_LIKE_ANALYSIS];
  const unique = new Map();
  let identifiable = 0;
  let complete = true;
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const trackKey = observationTrackKey(track);
    if (!trackKey) continue;
    identifiable += 1;
    const likeCount = num(track?.bite_count);
    if (likeCount == null) {
      complete = false;
      continue;
    }
    unique.set(trackKey, likeCount);
  }
  return {
    complete: identifiable === 0 || complete,
    payload: [...unique.entries()]
      .map(([trackKey, likeCount]) => ({ track_key: trackKey, like_count: likeCount }))
      .sort((left, right) => left.track_key.localeCompare(right.track_key)),
  };
}

function analyzeQueueIdentity(tracks) {
  const trackKeys = new Set();
  const isrcs = new Set();
  const spotifyIds = new Set();
  const positions = [];
  const positionSet = new Set();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const position = num(track?.position);
    if (position != null && !positionSet.has(position)) {
      positionSet.add(position);
      positions.push(position);
    }
    const isrc = normalizedTrackIsrc(track);
    if (isrc) isrcs.add(isrc);
    const spotifyId = normalizedTrackSpotifyId(track);
    if (!isrc && spotifyId) spotifyIds.add(spotifyId);
    const trackKey = observationTrackKey(track);
    if (trackKey) trackKeys.add(trackKey);
  }
  return {
    trackKeys: [...trackKeys],
    isrcs: [...isrcs],
    spotifyIds: [...spotifyIds],
    positions,
  };
}

export function hasCompleteLikeSnapshot(tracks) {
  return analyzeQueueLikes(tracks).complete;
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

function latestLikeLookupStatements(db, stationId, analysis) {
  const trackKeys = analysis?.trackKeys || [];
  const isrcs = analysis?.isrcs || [];
  const spotifyIds = analysis?.spotifyIds || [];
  const statements = [];

  for (const group of chunks(trackKeys, QUERY_CHUNK).filter((chunk) => chunk.length)) {
    const placeholders = group.map(() => '?').join(',');
    statements.push(prepared(db.prepare(`SELECT track_key,observed_at,like_count,
      queue_track_id,stationhead_track_id,spotify_id,isrc
      FROM sh_track_like_current
      WHERE station_id IS ? AND track_key IN (${placeholders})`)
      .bind(stationId, ...group), 1 + group.length));
  }
  for (const group of chunks(isrcs, QUERY_CHUNK).filter((chunk) => chunk.length)) {
    const placeholders = group.map(() => '?').join(',');
    statements.push(prepared(db.prepare(`SELECT track_key,observed_at,like_count,
      queue_track_id,stationhead_track_id,spotify_id,isrc
      FROM sh_track_like_current
      WHERE station_id IS ? AND UPPER(TRIM(isrc)) IN (${placeholders})`)
      .bind(stationId, ...group), 1 + group.length));
  }
  for (const group of chunks(spotifyIds, QUERY_CHUNK).filter((chunk) => chunk.length)) {
    const placeholders = group.map(() => '?').join(',');
    statements.push(prepared(db.prepare(`SELECT track_key,observed_at,like_count,
      queue_track_id,stationhead_track_id,spotify_id,isrc
      FROM sh_track_like_current
      WHERE station_id IS ?
        AND (isrc IS NULL OR TRIM(isrc)='')
        AND spotify_id IN (${placeholders})`)
      .bind(stationId, ...group), 1 + group.length));
  }
  return statements;
}

async function loadComparisonState(db, stationId, startTime, positions, likeAnalysis, options) {
  const itemStatements = options.includeItems
    ? queueItemLookupStatements(db, stationId, startTime, positions)
    : [];
  const likeStatements = options.includeLikes
    ? latestLikeLookupStatements(db, stationId, likeAnalysis)
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
  if (!tracks.length) return [];
  const statement = db.prepare(`INSERT INTO sh_queue_items (
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
    ),sh_queue_items.observed_at)`);
  return tracks.map((track) => prepared(statement.bind(
      observedAt, stationId, queueId, startTime, num(track?.position),
      num(track?.queue_track_id), num(track?.stationhead_track_id),
      normalizedTrackSpotifyId(track), text(track?.deezer_id), normalizedTrackIsrc(track),
      num(track?.duration_ms), text(track?.preview_url),
      num(track?.bite_count), compactQueueItemRaw(track, queueId),
    ), 14));
}

function queueItemLikeUpdateStatements(db, tracks, observedAt, stationId, startTime) {
  const eligible = (Array.isArray(tracks) ? tracks : [])
    .filter((track) => num(track?.position) != null && num(track?.bite_count) != null)
  if (!eligible.length) return [];
  const statement = db.prepare(`UPDATE sh_queue_items
      SET bite_count=?
      WHERE station_id IS ? AND start_time IS ? AND position IS ?
        AND bite_count IS NOT ?
        AND ?>=COALESCE((
          SELECT MAX(snapshot.observed_at) FROM sh_queue_snapshots snapshot
          WHERE snapshot.station_id IS ? AND snapshot.start_time IS ?
        ),0)`);
  return eligible.map((track) => prepared(statement.bind(
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

const LIKE_CURRENT_SQL = `INSERT INTO sh_track_like_current (
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
      AND excluded.like_count IS NOT sh_track_like_current.like_count`;

const LIKE_OBSERVATION_SQL = `INSERT INTO sh_track_like_observations (
        observed_at,station_id,queue_id,start_time,position,
        queue_track_id,stationhead_track_id,spotify_id,isrc,
        track_key,like_count,source,raw_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`;

function likeCurrentStatement(db, entry, observedAt, stationId, queueId, startTime, statement = null) {
  const { trackKey, track } = entry;
  const base = statement || db.prepare(LIKE_CURRENT_SQL);
  return prepared(base.bind(
      stationId, trackKey, queueId, startTime, num(track?.position),
      num(track?.queue_track_id), num(track?.stationhead_track_id),
      normalizedTrackSpotifyId(track), normalizedTrackIsrc(track), num(track?.bite_count), observedAt,
      observedAt, stationId,
    ), 13);
}

function likeCurrentMigrationStatements(db, migrations, observedAt, stationId, queueId, startTime) {
  if (!migrations.length) return [];
  const statement = db.prepare(LIKE_CURRENT_SQL);
  return migrations.map((entry) => likeCurrentStatement(
    db,
    entry,
    observedAt,
    stationId,
    queueId,
    startTime,
    statement,
  ));
}

function likeWriteStatements(db, observations, observedAt, stationId, queueId, startTime) {
  if (!observations.length) return [];
  const currentStatement = db.prepare(LIKE_CURRENT_SQL);
  const observationStatement = db.prepare(LIKE_OBSERVATION_SQL);
  return observations.flatMap((entry) => {
    const { trackKey, track } = entry;
    return [
      likeCurrentStatement(db, entry, observedAt, stationId, queueId, startTime, currentStatement),
      prepared(observationStatement.bind(
        observedAt, stationId, queueId, startTime, num(track?.position),
        num(track?.queue_track_id), num(track?.stationhead_track_id),
        normalizedTrackSpotifyId(track), normalizedTrackIsrc(track),
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
  // Queue persistence only consumes the normalized structural/identity fields
  // below. The old recursive playback-field scrub walked every upstream raw
  // track before those fields were selected, even though raw JSON is rebuilt
  // from structuralPayload later in this function.
  const data = body?.data ?? {};
  const structuralPayload = queueStructuralPayload(data);
  const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
  const likeAnalysis = analyzeQueueLikes(tracks);
  const completeLikes = likeAnalysis.complete;
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
  const cache = queueHashCacheFor(stationId);
  const structuralCacheHit = cache.structuralHash === current?.structural_hash
    && structuralSignatureMatches(cache.structuralSignature, structuralPayload);
  const structuralHash = structuralCacheHit
    ? cache.structuralHash
    : await payloadHash(structuralPayload);
  const currentWatermark = Math.max(
    num(current?.observed_at) ?? 0,
    num(current?.latest_reachability_at) ?? 0,
  );
  const staleCurrent = currentWatermark > 0 && observedAt < currentWatermark;
  const likesCacheHit = completeLikes
    && cache.likesHash === current?.likes_hash
    && likesSignatureMatches(cache.likesSignature, likeAnalysis.payload);
  const likesHash = completeLikes
    ? likesCacheHit
      ? cache.likesHash
      : await payloadHash(likeAnalysis.payload)
    : text(current?.likes_hash);
  if (!structuralCacheHit) {
    cache.structuralHash = structuralHash;
    cache.structuralSignature = captureStructuralSignature(structuralPayload);
  }
  if (completeLikes && !likesCacheHit) {
    cache.likesHash = likesHash;
    cache.likesSignature = captureLikesSignature(likeAnalysis.payload);
  }
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

  const queueIdentity = analyzeQueueIdentity(tracks);
  const positions = queueIdentity.positions;
  const currentTrackKeys = completeLikes ? queueIdentity.trackKeys : [];
  const { existingRows, latestRows } = await loadComparisonState(
    db,
    stationId,
    startTime,
    positions,
    queueIdentity,
    { includeItems: structureChanged, includeLikes: likesChanged },
  );
  const changedTracks = structureChanged
    ? queueItemsToWriteLean(tracks, existingRows, queueId)
    : [];
  const likeChanges = likesChanged ? planLikeChanges(tracks, latestRows) : null;
  const observations = likeChanges?.observations || [];
  const currentLikeMigrations = likeChanges?.currentLikeMigrations || [];

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
