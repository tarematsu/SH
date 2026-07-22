import { num } from '../../site/functions/lib/api-utils.js';
import { prepared, runPreparedD1Batches } from '../../site/functions/lib/d1-batch.js';
import {
  analyzeQueueLikes,
  D1_BATCH_STATEMENT_LIMIT,
  D1_BATCH_VARIABLE_LIMIT,
} from '../../site/functions/lib/d1-optimized-ingest.js';
import {
  normalizedTrackIsrc,
  normalizedTrackSpotifyId,
  observationTrackKey,
  planLikeChanges,
} from '../../site/functions/lib/d1-lean-ingest.js';
import { payloadHash } from '../../site/functions/lib/ingest-claim.js';
import { restoreQueueAnalysis } from './queue-analysis-transfer.js';
import { saveQueuePlanR2 } from './queue-plan-r2.js';

const QUERY_CHUNK = 80;
const EMPTY_TRACKS = Object.freeze([]);
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });

function enabled(value, fallback = true) {
  if (value == null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

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

async function loadLikesComparisonState(db, stationId, startTime, analysis, includeLatest, includeRepair) {
  const statements = [];
  if (includeRepair) {
    statements.push(prepared(db.prepare(`SELECT position
      FROM sh_queue_items
      WHERE station_id IS ? AND start_time IS ? AND bite_count IS NULL`)
      .bind(stationId, startTime), 2));
  }
  const latestOffset = statements.length;
  if (includeLatest) statements.push(...latestLikeLookupStatements(db, stationId, analysis));
  if (!statements.length) return { nullPositions: [], latestRows: [] };
  const results = await runPreparedD1Batches(db, statements, {
    variableLimit: D1_BATCH_VARIABLE_LIMIT,
    statementLimit: D1_BATCH_STATEMENT_LIMIT,
    fallbackMethod: 'all',
  });
  return {
    nullPositions: includeRepair
      ? uniqueNumbers((results[0]?.results || []).map((row) => row?.position))
      : [],
    latestRows: results.slice(latestOffset).flatMap((result) => result?.results || []),
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

export async function prepareQueueLikesPersistenceWithinBudget(env, body, observedAt) {
  const db = env?.DB;
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
  const includeRepair = body?.metadata_requested === true
    || enabled(env?.QUEUE_LIKES_REPAIR_ENABLED, true);
  if (!likesChanged && !includeRepair) {
    return {
      likes_changed: false,
      complete_likes: completeLikes,
      stale_current: staleCurrent,
      station_id: stationId,
      queue_id: queueId,
      start_time: startTime,
      structural_hash: current?.structural_hash ?? body?.analysis?.structural_hash ?? null,
      likes_hash: likesHash,
      current_track_keys: [],
      observation_keys: [],
      migration_keys: [],
      queue_item_positions: [],
      track_count: tracks.length,
      needs_write: false,
    };
  }
  const identity = analyzeQueueIdentity(tracks);
  const comparison = await loadLikesComparisonState(
    db,
    stationId,
    startTime,
    identity,
    likesChanged,
    includeRepair,
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

function compactMaterializationData(data, analysis) {
  const tracks = Array.isArray(data?.tracks) ? data.tracks : EMPTY_TRACKS;
  return {
    station_id: data?.station_id ?? null,
    queue_id: data?.queue_id ?? null,
    start_time: data?.start_time ?? null,
    source_structural_hash: data?.source_structural_hash ?? analysis?.source_structural_hash ?? null,
    source_likes_hash: data?.source_likes_hash ?? analysis?.source_likes_hash ?? null,
    total_track_count: Number(data?.total_track_count || tracks.length || 0),
    materialized_track_count: Number(data?.materialized_track_count || tracks.length || 0),
  };
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

export async function processOptimizedQueueLikesPlanTask(env, body, dependencies = {}) {
  if (!env?.DB?.prepare) throw new Error('DB binding is missing');
  const observedAt = Number(body?.observed_at);
  if (!Number.isFinite(observedAt)) throw new Error('persistence observed_at is missing');
  if (!body?.data || typeof body.data !== 'object') throw new Error('persistence data is missing');
  if (body.stage !== 'likes') throw new Error(`unsupported optimized likes plan stage: ${String(body?.stage || '')}`);

  const prepare = dependencies.prepareQueueLikesPersistence
    || prepareQueueLikesPersistenceWithinBudget;
  const plan = await prepare(env, body, observedAt);
  if (!plan.needs_write) {
    const deferred = await sendContinuation(env, {
      message_type: 'stationhead-persistence-task',
      message_version: 1,
      task: 'queue',
      stage: 'finalize',
      observed_at: observedAt,
      collector_id: body?.collector_id || 'cloudflare-worker',
      data: compactMaterializationData(body?.data, body?.analysis),
      metadata_requested: body?.metadata_requested === true,
    }, dependencies);
    if (!deferred) throw new Error('PERSIST_QUEUE binding is missing for finalization');
    const savePlanCache = dependencies.saveQueuePlanCache || saveQueuePlanR2;
    await savePlanCache(env.PAGES_RESPONSE_R2, body, observedAt, plan);
    return {
      task: 'queue',
      stage: 'likes',
      observed_at: observedAt,
      total_track_count: Number(body.data?.total_track_count || plan.track_count || 0),
      materialized_track_count: Number(body.data?.materialized_track_count || plan.track_count || 0),
      likes_changed: plan.likes_changed === true,
      likes_write_deferred: false,
      finalization_deferred: true,
    };
  }
  const deferred = await sendContinuation(env, {
    ...body,
    stage: 'likes-write',
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
