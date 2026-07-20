import {
  commitQueueStructurePersistence,
  prepareQueueStructurePersistence,
} from './persist-structure-stages.js';

const EMPTY_TRACKS = Object.freeze([]);
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
const DEFAULT_WRITE_POSITIONS = 12;

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function queueCounts(data) {
  const tracks = Array.isArray(data?.tracks) ? data.tracks : EMPTY_TRACKS;
  return {
    total_track_count: Number(data?.total_track_count || tracks.length || 0),
    materialized_track_count: Number(data?.materialized_track_count || tracks.length || 0),
  };
}

function validate(body) {
  if (body?.message_type !== 'stationhead-persistence-task'
      || Number(body?.message_version) !== 1
      || body?.task !== 'queue') {
    throw new Error('unsupported structure persistence task');
  }
  const stage = body.stage == null ? 'persist' : body.stage;
  if (stage !== 'persist' && stage !== 'structure-write') {
    throw new Error(`unsupported structure persistence stage: ${String(stage)}`);
  }
  const observedAt = Number(body.observed_at);
  if (!Number.isFinite(observedAt)) throw new Error('persistence observed_at is missing');
  if (!body.data || typeof body.data !== 'object') throw new Error('persistence data is missing');
  return { stage, observedAt };
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
  const { stage, observedAt } = validate(body);
  if (stage === 'persist') {
    const prepare = dependencies.prepareQueueStructurePersistence
      || prepareQueueStructurePersistence;
    const plan = await prepare(env.DB, body, observedAt);
    if (plan?.structure_changed !== true) {
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

  const likesDeferred = await sendContinuation(
    env,
    likesMessage(body, observedAt, result),
    dependencies,
  );
  if (!likesDeferred) throw new Error('PERSIST_QUEUE binding is missing for likes');
  return {
    task: 'queue',
    stage,
    observed_at: observedAt,
    ...result,
    ...queueCounts(body.data),
    structure_write_deferred: false,
    likes_deferred: true,
    next_cursor: null,
    finalization_deferred: true,
  };
}
