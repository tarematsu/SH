import { bool, num, rawJson } from '../../site/functions/lib/api-utils.js';
import { prepared, runPreparedD1Batches } from '../../site/functions/lib/d1-batch.js';
import {
  analyzeQueueLikes,
  D1_BATCH_STATEMENT_LIMIT,
  D1_BATCH_VARIABLE_LIMIT,
  D1_SINGLE_STATEMENT_VARIABLE_LIMIT,
} from '../../site/functions/lib/d1-optimized-ingest.js';
import {
  normalizedTrackIsrc,
  normalizedTrackSpotifyId,
  observationTrackKey,
  planLikeChanges,
} from '../../site/functions/lib/d1-lean-ingest.js';
import { payloadHash } from '../../site/functions/lib/ingest-claim.js';
import { restoreQueueAnalysis } from './queue-analysis-transfer.js';

export const QUEUE_STAGE_LIKES_WRITE = 'likes-write';
export const LIKES_WRITE_TRACK_LIMIT = 24;

const QUERY_CHUNK = 80;
const EMPTY_TRACKS = Object.freeze([]);
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function uniqueNumbers(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const number = num(value);
    if (number == null || seen.has(number)) continue;
    seen.add(number);
    result.push(number);
  }
  return result;
}

function analyzeQueueIdentity(tracks) {
  const trackKeys = new Set();
  const isrcs = new Set();
  const spotifyIds = new Set();
  for (const track of Array.isArray(tracks) ? tracks : EMPTY_TRACKS) {
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
  };
}

function latestLikeLookupStatements(db, stationId, analysis) {
  const statements = [];
  for (const group of chunks(analysis.trackKeys, QUERY_CHUNK)) {
    if (!group.length) continue;
    const placeholders = group.map(() => '?').join(',');
    statements.push(prepared(db.prepare(`SELECT track_key,observed_at,like_count,
      queue_track_id,stationhead_track_id,spotify_id,isrc
      FROM sh_track_like_current
      WHERE station_id IS ? AND track_key IN (${placeholders})`)
      .bind(stationId, ...group), 1 + group.length));
  }
  for (const group of chunks(analysis.isrcs, QUERY_CHUNK)) {
    if (!group.length) continue;
    const placeholders = group.map(() => '?').join(',');
    statements.push(prepared(db.prepare(`SELECT track_key,observed_at,like_count,
      queue_track_id,stationhead_track_id,spotify_id,isrc
      FROM sh_track_like_current
      WHERE station_id IS ? AND UPPER(TRIM(isrc)) IN (${placeholders})`)
      .bind(stationId, ...group), 1 + group.length));
  }
  for (const group of chunks(analysis.spotifyIds, QUERY_CHUNK)) {
    if (!group.length) continue;
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

async function loadLikesComparisonState(db, stationId, startTime, analysis, includeLatest) {
  const statements = [prepared(db.prepare(`SELECT position
    FROM sh_queue_items
    WHERE station_id IS ? AND start_time IS ? AND bite_count IS NULL`)
    .bind(stationId, startTime), 2)];
  const latestStatements = includeLatest ? latestLikeLookupStatements(db, stationId, analysis) : [];
  statements.push(...latestStatements);
  const results = await runPreparedD1Batches(db, statements, {
    variableLimit: D1_BATCH_VARIABLE_LIMIT,
    statementLimit: D1_BATCH_STATEMENT_LIMIT,
    fallbackMethod: 'all',
  });
  return {
    nullPositions: uniqueNumbers((results[0]?.results || []).map((row) => row?.position)),
    latestRows: results.slice(1).flatMap((result) => result?.results || []),
  };
}

function queueItemPositions(tracks, nullPositions, changedKeys) {
  const positions = new Set(nullPositions);
  for (const track of Array.isArray(tracks) ? tracks : EMPTY_TRACKS) {
    const key = observationTrackKey(track);
    const position = num(track?.position);
    if (position != null && key && changedKeys.has(key)) positions.add(position);
  }
  return [...positions];
}

export async function prepareQueueLikesPersistence(db, body, observedAt) {
  restoreQueueAnalysis(body?.data, body?.analysis);
  const data = body?.data || {};
  const tracks = Array.isArray(data?.tracks) ? data.tracks : EMPTY_TRACKS;
  const stationId = num(data?.station_id);
  const startTime = num(data?.start_time);
  const queueId = num(data?.queue_id);
  const current = await db.prepare(`SELECT current.structural_hash,current.likes_hash,
      current.observed_at,COALESCE((
        SELECT MAX(snapshot.observed_at) FROM sh_queue_snapshots snapshot
        WHERE snapshot.station_id IS current.station_id
      ),0) AS latest_reachability_at
    FROM sh_queue_current current WHERE current.station_id IS ?`)
    .bind(stationId).first();
  const likeAnalysis = analyzeQueueLikes(tracks);
  const completeLikes = likeAnalysis.complete;
  const preparedHash = typeof body?.analysis?.likes_hash === 'string'
    ? body.analysis.likes_hash
    : null;
  const likesHash = completeLikes
    ? preparedHash || await payloadHash(likeAnalysis.payload)
    : current?.likes_hash ?? null;
  const currentWatermark = Math.max(
    num(current?.observed_at) ?? 0,
    num(current?.latest_reachability_at) ?? 0,
  );
  const staleCurrent = currentWatermark > 0 && observedAt < currentWatermark;
  const likesChanged = completeLikes && current?.likes_hash !== likesHash;
  const identity = analyzeQueueIdentity(tracks);
  const comparison = await loadLikesComparisonState(
    db,
    stationId,
    startTime,
    identity,
    likesChanged,
  );
  const changes = likesChanged ? planLikeChanges(tracks, comparison.latestRows) : null;
  const observationKeys = (changes?.observations || []).map((entry) => entry.trackKey);
  const migrationKeys = (changes?.currentLikeMigrations || []).map((entry) => entry.trackKey);
  const changedKeys = new Set(observationKeys.concat(migrationKeys));
  const itemPositions = queueItemPositions(tracks, comparison.nullPositions, changedKeys);
  return {
    likes_changed: likesChanged,
    complete_likes: completeLikes,
    stale_current: staleCurrent,
    station_id: stationId,
    queue_id: queueId,
    start_time: startTime,
    structural_hash: current?.structural_hash ?? body?.analysis?.structural_hash ?? null,
    likes_hash: likesHash,
    current_track_keys: identity.trackKeys,
    observation_keys: observationKeys,
    migration_keys: migrationKeys,
    queue_item_positions: itemPositions,
    track_count: tracks.length,
    needs_write: !staleCurrent && (likesChanged || itemPositions.length > 0),
  };
}

function deleteMissingCurrentLikesStatement(db, plan, observedAt) {
  const trackKeys = Array.isArray(plan?.current_track_keys) ? plan.current_track_keys : [];
  if (!trackKeys.length) {
    return prepared(db.prepare(`DELETE FROM sh_track_like_current
      WHERE station_id IS ?
        AND ?>=COALESCE((
          SELECT MAX(snapshot.observed_at) FROM sh_queue_snapshots snapshot
          WHERE snapshot.station_id IS ?
        ),0)`).bind(plan.station_id, observedAt, plan.station_id), 3);
  }
  if (3 + trackKeys.length > D1_SINGLE_STATEMENT_VARIABLE_LIMIT) return null;
  const placeholders = trackKeys.map(() => '?').join(',');
  return prepared(db.prepare(`DELETE FROM sh_track_like_current
    WHERE station_id IS ? AND track_key NOT IN (${placeholders})
      AND ?>=COALESCE((
        SELECT MAX(snapshot.observed_at) FROM sh_queue_snapshots snapshot
        WHERE snapshot.station_id IS ?
      ),0)`)
    .bind(plan.station_id, ...trackKeys, observedAt, plan.station_id), 3 + trackKeys.length);
}

function queueItemLikeUpdateStatements(db, tracks, positions, observedAt, plan) {
  if (!positions.size) return [];
  const statement = db.prepare(`UPDATE sh_queue_items
    SET bite_count=?
    WHERE station_id IS ? AND start_time IS ? AND position IS ?
      AND bite_count IS NOT ?
      AND ?>=COALESCE((
        SELECT MAX(snapshot.observed_at) FROM sh_queue_snapshots snapshot
        WHERE snapshot.station_id IS ? AND snapshot.start_time IS ?
      ),0)`);
  const statements = [];
  for (const track of tracks) {
    const position = num(track?.position);
    const likeCount = num(track?.bite_count);
    if (position == null || likeCount == null || !positions.has(position)) continue;
    statements.push(prepared(statement.bind(
      likeCount,
      plan.station_id,
      plan.start_time,
      position,
      likeCount,
      observedAt,
      plan.station_id,
      plan.start_time,
    ), 8));
  }
  return statements;
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
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(observed_at,station_id,track_key) DO UPDATE SET
    queue_id=excluded.queue_id,start_time=excluded.start_time,position=excluded.position,
    queue_track_id=excluded.queue_track_id,stationhead_track_id=excluded.stationhead_track_id,
    spotify_id=excluded.spotify_id,isrc=excluded.isrc,like_count=excluded.like_count,
    source=excluded.source,raw_json=excluded.raw_json`;

function likeCurrentStatement(db, entry, observedAt, plan, statement) {
  const { trackKey, track } = entry;
  return prepared(statement.bind(
    plan.station_id,
    trackKey,
    plan.queue_id,
    plan.start_time,
    num(track?.position),
    num(track?.queue_track_id),
    num(track?.stationhead_track_id),
    normalizedTrackSpotifyId(track),
    normalizedTrackIsrc(track),
    num(track?.bite_count),
    observedAt,
    observedAt,
    plan.station_id,
  ), 13);
}

function likeWriteStatements(db, entries, observedAt, plan, includeObservation) {
  if (!entries.length) return [];
  const currentStatement = db.prepare(LIKE_CURRENT_SQL);
  const observationStatement = includeObservation ? db.prepare(LIKE_OBSERVATION_SQL) : null;
  const statements = [];
  for (const entry of entries) {
    statements.push(likeCurrentStatement(db, entry, observedAt, plan, currentStatement));
    if (!observationStatement) continue;
    const { trackKey, track } = entry;
    statements.push(prepared(observationStatement.bind(
      observedAt,
      plan.station_id,
      plan.queue_id,
      plan.start_time,
      num(track?.position),
      num(track?.queue_track_id),
      num(track?.stationhead_track_id),
      normalizedTrackSpotifyId(track),
      normalizedTrackIsrc(track),
      trackKey,
      num(track?.bite_count),
      'collector',
      rawJson({ bite_count: num(track?.bite_count) }),
    ), 13));
  }
  return statements;
}

function queueCurrentStatement(db, body, plan, observedAt) {
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
      bool(body?.data?.is_paused),
      observedAt,
      Date.now(),
    ), 8);
}

function uniqueTrackIndexes(tracks) {
  const indexes = new Map();
  for (let index = 0; index < tracks.length; index += 1) {
    const key = observationTrackKey(tracks[index]);
    if (key) indexes.set(key, index);
  }
  return indexes;
}

function entriesForChunk(tracks, keys, indexes, start, end) {
  const wanted = new Set(keys || []);
  const entries = [];
  for (const [trackKey, index] of indexes) {
    if (index < start || index >= end || !wanted.has(trackKey)) continue;
    entries.push({ trackKey, track: tracks[index] });
  }
  return entries;
}

export async function commitQueueLikesPersistenceChunk(
  db,
  body,
  observedAt,
  plan,
  cursor = 0,
  limit = LIKES_WRITE_TRACK_LIMIT,
) {
  const tracks = Array.isArray(body?.data?.tracks) ? body.data.tracks : EMPTY_TRACKS;
  const start = Math.max(0, Math.trunc(Number(cursor) || 0));
  const size = Math.max(1, Math.trunc(Number(limit) || LIKES_WRITE_TRACK_LIMIT));
  const end = Math.min(tracks.length, start + size);
  const finalChunk = end >= tracks.length;
  const chunk = tracks.slice(start, end);
  const positions = new Set(plan?.queue_item_positions || []);
  const indexes = uniqueTrackIndexes(tracks);
  const observations = entriesForChunk(tracks, plan?.observation_keys, indexes, start, end);
  const migrations = entriesForChunk(tracks, plan?.migration_keys, indexes, start, end);
  const statements = [];

  if (start === 0 && plan?.likes_changed && !plan?.stale_current) {
    const prune = deleteMissingCurrentLikesStatement(db, plan, observedAt);
    if (prune) statements.push(prune);
  }
  if (!plan?.stale_current) {
    statements.push(...queueItemLikeUpdateStatements(db, chunk, positions, observedAt, plan));
    statements.push(...likeWriteStatements(db, migrations, observedAt, plan, false));
  }
  statements.push(...likeWriteStatements(db, observations, observedAt, plan, true));
  if (finalChunk && plan?.likes_changed && !plan?.stale_current) {
    statements.push(queueCurrentStatement(db, body, plan, observedAt));
  }
  if (statements.length) {
    await runPreparedD1Batches(db, statements, {
      variableLimit: D1_BATCH_VARIABLE_LIMIT,
      statementLimit: D1_BATCH_STATEMENT_LIMIT,
      fallbackMethod: 'run',
    });
  }
  return {
    inspected: true,
    structureChanged: false,
    likesChanged: plan?.likes_changed === true,
    completeLikes: plan?.complete_likes !== false,
    staleCurrent: plan?.stale_current === true,
    itemsWritten: chunk.filter((track) => positions.has(num(track?.position)) && num(track?.bite_count) != null).length,
    observationsWritten: observations.length,
    currentLikeMigrationsWritten: plan?.stale_current ? 0 : migrations.length,
    next_cursor: finalChunk ? null : end,
    likes_write_complete: finalChunk,
  };
}

function compactMaterializationData(data, analysis) {
  const tracks = Array.isArray(data?.tracks) ? data.tracks : EMPTY_TRACKS;
  const totalTrackCount = Number(data?.total_track_count || tracks.length || 0);
  const materializedTrackCount = Number(data?.materialized_track_count || tracks.length || 0);
  return {
    station_id: data?.station_id ?? null,
    queue_id: data?.queue_id ?? null,
    start_time: data?.start_time ?? null,
    source_structural_hash: data?.source_structural_hash ?? analysis?.source_structural_hash ?? null,
    source_likes_hash: data?.source_likes_hash ?? analysis?.source_likes_hash ?? null,
    total_track_count: totalTrackCount,
    materialized_track_count: materializedTrackCount,
  };
}

function compactMetadataQueue(data) {
  const sourceTracks = Array.isArray(data?.tracks) ? data.tracks : EMPTY_TRACKS;
  const tracks = [];
  for (const track of sourceTracks) {
    const spotifyId = track?.spotify_id ?? null;
    const isrc = track?.isrc ?? null;
    if (spotifyId || isrc) tracks.push({ spotify_id: spotifyId, isrc });
  }
  return {
    station_id: data?.station_id ?? null,
    queue_id: data?.queue_id ?? null,
    start_time: data?.start_time ?? null,
    tracks,
  };
}

function finalizationMessage(body, observedAt, result) {
  const metadataRequested = body?.metadata_requested === true || result?.structureChanged === true;
  const message = {
    message_type: 'stationhead-persistence-task',
    message_version: 1,
    task: 'queue',
    stage: 'finalize',
    observed_at: observedAt,
    collector_id: body?.collector_id || 'cloudflare-worker',
    data: compactMaterializationData(body?.data, body?.analysis),
    metadata_requested: metadataRequested,
  };
  if (metadataRequested) {
    const queue = compactMetadataQueue(body?.data);
    if (queue.tracks.length) message.metadata_queue = queue;
  }
  return message;
}

async function sendContinuation(env, message, dependencies) {
  if (dependencies?.sendPersistenceContinuation) {
    await dependencies.sendPersistenceContinuation(message);
    return true;
  }
  if (!env?.PERSIST_QUEUE?.send) return false;
  await env.PERSIST_QUEUE.send(message, JSON_QUEUE_SEND_OPTIONS);
  return true;
}

export async function processOptimizedQueueLikesTask(env, body, dependencies = {}) {
  if (!env?.DB?.prepare) throw new Error('DB binding is missing');
  const observedAt = Number(body?.observed_at);
  if (!Number.isFinite(observedAt)) throw new Error('persistence observed_at is missing');
  if (!body?.data || typeof body.data !== 'object') throw new Error('persistence data is missing');

  if (body.stage === 'likes') {
    const prepare = dependencies.prepareQueueLikesPersistence || prepareQueueLikesPersistence;
    const plan = await prepare(env.DB, body, observedAt);
    if (!plan.needs_write) {
      const deferred = await sendContinuation(env, finalizationMessage(body, observedAt, plan), dependencies);
      return {
        task: 'queue',
        stage: 'likes',
        observed_at: observedAt,
        total_track_count: Number(body.data?.total_track_count || plan.track_count || 0),
        materialized_track_count: Number(body.data?.materialized_track_count || plan.track_count || 0),
        likes_changed: plan.likes_changed === true,
        likes_write_deferred: false,
        finalization_deferred: deferred,
      };
    }
    const deferred = await sendContinuation(env, {
      ...body,
      stage: QUEUE_STAGE_LIKES_WRITE,
      likes_plan: plan,
      likes_cursor: 0,
    }, dependencies);
    if (!deferred) throw new Error('PERSIST_QUEUE binding is missing for likes-write');
    return {
      task: 'queue',
      stage: 'likes',
      observed_at: observedAt,
      total_track_count: Number(body.data?.total_track_count || plan.track_count || 0),
      materialized_track_count: Number(body.data?.materialized_track_count || plan.track_count || 0),
      likes_changed: plan.likes_changed === true,
      likes_write_deferred: true,
      finalization_deferred: true,
    };
  }

  if (body.stage !== QUEUE_STAGE_LIKES_WRITE || !body.likes_plan) {
    throw new Error(`unsupported optimized likes stage: ${String(body?.stage || '')}`);
  }
  const commit = dependencies.commitQueueLikesPersistenceChunk || commitQueueLikesPersistenceChunk;
  const result = await commit(
    env.DB,
    body,
    observedAt,
    body.likes_plan,
    body.likes_cursor,
    dependencies.likesWriteTrackLimit,
  );
  if (result.next_cursor != null) {
    const deferred = await sendContinuation(env, {
      ...body,
      likes_cursor: result.next_cursor,
    }, dependencies);
    if (!deferred) throw new Error('PERSIST_QUEUE binding is missing for likes-write continuation');
    return {
      task: 'queue',
      stage: QUEUE_STAGE_LIKES_WRITE,
      observed_at: observedAt,
      ...result,
      total_track_count: Number(body.data?.total_track_count || body.likes_plan.track_count || 0),
      materialized_track_count: Number(body.data?.materialized_track_count || body.likes_plan.track_count || 0),
      likes_write_deferred: true,
      finalization_deferred: true,
    };
  }
  const finalizationDeferred = await sendContinuation(
    env,
    finalizationMessage(body, observedAt, result),
    dependencies,
  );
  if (!finalizationDeferred) throw new Error('PERSIST_QUEUE binding is missing for finalization');
  return {
    task: 'queue',
    stage: QUEUE_STAGE_LIKES_WRITE,
    observed_at: observedAt,
    ...result,
    total_track_count: Number(body.data?.total_track_count || body.likes_plan.track_count || 0),
    materialized_track_count: Number(body.data?.materialized_track_count || body.likes_plan.track_count || 0),
    likes_write_deferred: false,
    finalization_deferred: true,
  };
}
