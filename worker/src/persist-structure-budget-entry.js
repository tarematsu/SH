import {
  commitQueueStructurePersistence,
  prepareQueueStructurePersistence,
} from './persist-structure-stages.js';

const EMPTY_TRACKS = Object.freeze([]);
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
const DEFAULT_WRITE_POSITIONS = 12;
const DEFAULT_STABLE_CHECKPOINT_MINUTES = 20;
const MAX_STABLE_CHECKPOINT_MINUTES = 60;
const MINUTE_MS = 60_000;

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function enabled(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function queueCounts(data) {
  const tracks = Array.isArray(data?.tracks) ? data.tracks : EMPTY_TRACKS;
  return {
    total_track_count: Number(data?.total_track_count || tracks.length || 0),
    materialized_track_count: Number(data?.materialized_track_count || tracks.length || 0),
  };
}

function compactMaterializationData(data, analysis) {
  const counts = queueCounts(data);
  return {
    station_id: data?.station_id ?? null,
    queue_id: data?.queue_id ?? null,
    start_time: data?.start_time ?? null,
    source_structural_hash: data?.source_structural_hash
      ?? analysis?.source_structural_hash
      ?? null,
    source_likes_hash: data?.source_likes_hash
      ?? analysis?.source_likes_hash
      ?? null,
    total_track_count: counts.total_track_count,
    materialized_track_count: counts.materialized_track_count,
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

function finalizationMessage(body, observedAt, structureChanged = false) {
  const metadataRequested = body?.metadata_requested === true || structureChanged;
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

function incomingLikesHash(body) {
  return typeof body?.analysis?.likes_hash === 'string' ? body.analysis.likes_hash : null;
}

export function queueLikesStageRequired(body, plan, env = {}) {
  if (enabled(env.QUEUE_LIKES_REPAIR_ENABLED, false)) return true;
  const hash = incomingLikesHash(body);
  const complete = body?.analysis?.likes?.complete !== false && hash != null;
  return !complete || String(plan?.likes_hash ?? '') !== hash;
}

export function queuePersistenceCheckpointDue(observedAt, env = {}) {
  const timestamp = Number(observedAt);
  if (!Number.isFinite(timestamp) || timestamp < 0) return true;
  const interval = positiveInteger(
    env.QUEUE_STABLE_CHECKPOINT_MINUTES,
    DEFAULT_STABLE_CHECKPOINT_MINUTES,
    MAX_STABLE_CHECKPOINT_MINUTES,
  );
  return Math.floor(timestamp / MINUTE_MS) % interval === 0;
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

function likesMessage(body, observedAt, result) {
  return {
    message_type: 'stationhead-persistence-task',
    message_version: 1,
    task: 'queue',
    stage: 'likes',
    observed_at: observedAt,
    collector_id: body.collector_id || 'cloudflare-worker',
    data: body.data,
    analysis: body.analysis || null,
    metadata_requested: body.metadata_requested === true
      || result?.structureChanged === true
      || result?.structure_changed === true,
  };
}

export async function processBudgetedQueueStructureTask(env, body, dependencies = {}) {
  if (!env?.DB?.prepare) throw new Error('DB binding is missing');
  const stage = body?.stage == null ? 'persist' : body.stage;
  if (body?.message_type !== 'stationhead-persistence-task'
      || Number(body?.message_version) !== 1
      || body?.task !== 'queue'
      || (stage !== 'persist' && stage !== 'structure-write')) {
    throw new Error('unsupported structure persistence task');
  }
  const observedAt = Number(body.observed_at);
  if (!Number.isFinite(observedAt)) throw new Error('persistence observed_at is missing');
  if (!body.data || typeof body.data !== 'object') throw new Error('persistence data is missing');

  if (stage === 'persist') {
    const prepare = dependencies.prepareQueueStructurePersistence
      || prepareQueueStructurePersistence;
    const plan = await prepare(env.DB, body, observedAt);
    if (plan?.structure_changed !== true) {
      const needsLikes = queueLikesStageRequired(body, plan, env);
      if (!needsLikes) {
        const checkpointDue = body.metadata_requested === true
          || queuePersistenceCheckpointDue(observedAt, env);
        let finalizationDeferred = false;
        if (checkpointDue) {
          finalizationDeferred = await sendContinuation(
            env,
            finalizationMessage(body, observedAt, false),
            dependencies,
          );
          if (!finalizationDeferred) throw new Error('PERSIST_QUEUE binding is missing for finalization');
        }
        return {
          task: 'queue',
          stage,
          observed_at: observedAt,
          ...queueCounts(body.data),
          structure_changed: false,
          structure_write_deferred: false,
          likes_deferred: false,
          stable_checkpoint_skipped: !checkpointDue,
          finalization_deferred: finalizationDeferred,
        };
      }
      const likesDeferred = await sendContinuation(
        env,
        likesMessage(body, observedAt, plan),
        dependencies,
      );
      if (!likesDeferred) throw new Error('PERSIST_QUEUE binding is missing for likes');
      return {
        task: 'queue',
        stage,
        observed_at: observedAt,
        ...queueCounts(body.data),
        structure_changed: false,
        structure_write_deferred: false,
        likes_deferred: true,
        finalization_deferred: true,
      };
    }
    const deferred = await sendContinuation(env, {
      ...body,
      stage: 'structure-write',
      structure_plan: plan,
      structure_cursor: 0,
      metadata_requested: body.metadata_requested === true || plan.structure_changed === true,
    }, dependencies);
    if (!deferred) throw new Error('PERSIST_QUEUE binding is missing for structure-write');
    return {
      task: 'queue',
      stage,
      observed_at: observedAt,
      ...queueCounts(body.data),
      structure_changed: true,
      structure_write_deferred: true,
      finalization_deferred: true,
    };
  }

  const plan = body.structure_plan;
  if (!plan || typeof plan !== 'object') throw new Error('structure persistence plan is missing');
  const positions = Array.isArray(plan.write_positions) ? plan.write_positions : EMPTY_TRACKS;
  const start = Math.max(0, Math.trunc(Number(body.structure_cursor) || 0));
  const limit = positiveInteger(
    dependencies.structureWritePositionLimit ?? env?.QUEUE_STRUCTURE_WRITE_POSITIONS,
    DEFAULT_WRITE_POSITIONS,
    24,
  );
  const end = Math.min(positions.length, start + limit);
  const finalChunk = end >= positions.length;
  const activePlan = {
    ...plan,
    write_positions: positions.slice(start, end),
    ...(finalChunk ? null : { stale_current: true, snapshot_required: false }),
  };
  const commit = dependencies.commitQueueStructurePersistence
    || commitQueueStructurePersistence;
  const result = await commit(env.DB, body, observedAt, activePlan);
  if (!finalChunk) {
    const deferred = await sendContinuation(env, {
      ...body,
      structure_cursor: end,
    }, dependencies);
    if (!deferred) throw new Error('PERSIST_QUEUE binding is missing for structure-write continuation');
    return {
      task: 'queue',
      stage,
      observed_at: observedAt,
      ...result,
      ...queueCounts(body.data),
      structure_write_deferred: true,
      likes_deferred: false,
      next_cursor: end,
      finalization_deferred: true,
    };
  }

  const needsLikes = queueLikesStageRequired(body, plan, env);
  const continuation = needsLikes
    ? likesMessage(body, observedAt, result)
    : finalizationMessage(body, observedAt, true);
  const deferred = await sendContinuation(env, continuation, dependencies);
  if (!deferred) {
    throw new Error(`PERSIST_QUEUE binding is missing for ${needsLikes ? 'likes' : 'finalization'}`);
  }
  return {
    task: 'queue',
    stage,
    observed_at: observedAt,
    ...result,
    ...queueCounts(body.data),
    structure_write_deferred: false,
    likes_deferred: needsLikes,
    next_cursor: null,
    finalization_deferred: true,
  };
}
