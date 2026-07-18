import { ingestOptimizedBody } from '../../site/functions/api/ingest.js';
import { restoreQueueAnalysis } from './queue-analysis-transfer.js';
import { recordQueueMaterialization } from './queue-materialization.js';
import { restoreSnapshotAnalysis, savePreparedSnapshot } from './snapshot-analysis-transfer.js';

const QUEUE_STAGE_PERSIST = 'persist';
const QUEUE_STAGE_LIKES = 'likes';
const QUEUE_STAGE_FINALIZE = 'finalize';
const EMPTY_DEPENDENCIES = Object.freeze({});
const EMPTY_TRACKS = Object.freeze([]);
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });

function validateTask(body) {
  if (body?.message_type !== 'stationhead-persistence-task') {
    throw new Error('unsupported persistence task');
  }
  const version = body.message_version;
  if (version !== 1 && Number(version) !== 1) {
    throw new Error('unsupported persistence task');
  }
  const task = body.task;
  if (task !== 'snapshot' && task !== 'queue') {
    throw new Error(`unsupported persistence task: ${String(task || '')}`);
  }
  const observedAt = Number(body.observed_at);
  if (!Number.isFinite(observedAt)) throw new Error('persistence observed_at is missing');
  if (!body.data || typeof body.data !== 'object') throw new Error('persistence data is missing');
  if (task !== 'queue') return { task, observedAt, stage: null };
  const stage = body.stage == null ? QUEUE_STAGE_PERSIST : body.stage;
  if (stage !== QUEUE_STAGE_PERSIST
      && stage !== QUEUE_STAGE_LIKES
      && stage !== QUEUE_STAGE_FINALIZE) {
    throw new Error(`unsupported persistence queue stage: ${String(stage)}`);
  }
  return { task, observedAt, stage };
}

function queueCounts(data) {
  const tracks = Array.isArray(data?.tracks) ? data.tracks : EMPTY_TRACKS;
  const trackCount = tracks.length;
  return {
    total_track_count: Number(data?.total_track_count || trackCount || 0),
    materialized_track_count: Number(data?.materialized_track_count || trackCount || 0),
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
  const tracks = new Array(sourceTracks.length);
  let count = 0;
  for (let index = 0; index < sourceTracks.length; index += 1) {
    const track = sourceTracks[index];
    const spotifyId = track?.spotify_id ?? null;
    const isrc = track?.isrc ?? null;
    if (!spotifyId && !isrc) continue;
    tracks[count] = { spotify_id: spotifyId, isrc };
    count += 1;
  }
  tracks.length = count;
  return {
    station_id: data?.station_id ?? null,
    queue_id: data?.queue_id ?? null,
    start_time: data?.start_time ?? null,
    tracks,
  };
}

function structuralQueueData(data, analysis) {
  const preparedTracks = analysis?.structural?.tracks;
  if (Array.isArray(preparedTracks)) return { ...data, tracks: preparedTracks };
  const sourceTracks = Array.isArray(data?.tracks) ? data.tracks : EMPTY_TRACKS;
  const tracks = new Array(sourceTracks.length);
  for (let index = 0; index < sourceTracks.length; index += 1) {
    const source = sourceTracks[index] || {};
    tracks[index] = {
      position: source.position ?? index,
      queue_track_id: source.queue_track_id ?? null,
      stationhead_track_id: source.stationhead_track_id ?? null,
      spotify_id: source.spotify_id ?? null,
      deezer_id: source.deezer_id ?? null,
      isrc: source.isrc ?? null,
      duration_ms: source.duration_ms ?? null,
      preview_url: source.preview_url ?? null,
    };
  }
  return { ...data, tracks };
}

async function enqueueQueueMetadata(env, body, observedAt, result, dependencies = EMPTY_DEPENDENCIES) {
  const requested = body.metadata_requested === true || result?.structure_changed === true;
  const queue = body.metadata_queue || body.data;
  const tracks = Array.isArray(queue?.tracks) ? queue.tracks : EMPTY_TRACKS;
  if (!requested || tracks.length === 0) return false;
  const stationId = Number(body.data?.station_id ?? queue?.station_id);
  const message = {
    message_type: 'stationhead-track-metadata',
    message_version: 1,
    task: 'committed-enrichment',
    job: {
      jobId: `queue-metadata:${Number.isFinite(stationId) ? Math.trunc(stationId) : 'unknown'}:${Math.trunc(observedAt)}`,
      payload: {
        observedAt,
        queue,
      },
      options: {
        enrichTrackMetadata: true,
      },
    },
  };
  if (dependencies.sendTrackMetadata) {
    await dependencies.sendTrackMetadata(message);
    return true;
  }
  const metadataQueue = env?.TRACK_METADATA_QUEUE;
  if (!metadataQueue?.send) throw new Error('TRACK_METADATA_QUEUE binding is missing');
  await metadataQueue.send(message, JSON_QUEUE_SEND_OPTIONS);
  return true;
}

async function sendPersistenceContinuation(env, continuation, dependencies) {
  if (dependencies.sendPersistenceContinuation) {
    await dependencies.sendPersistenceContinuation(continuation);
    return true;
  }
  if (!env?.PERSIST_QUEUE?.send) return false;
  await env.PERSIST_QUEUE.send(continuation, JSON_QUEUE_SEND_OPTIONS);
  return true;
}

async function enqueueQueueLikes(env, body, observedAt, result, dependencies = EMPTY_DEPENDENCIES) {
  return sendPersistenceContinuation(env, {
    message_type: 'stationhead-persistence-task',
    message_version: 1,
    task: 'queue',
    stage: QUEUE_STAGE_LIKES,
    observed_at: observedAt,
    collector_id: body.collector_id || 'cloudflare-worker',
    data: body.data,
    analysis: body.analysis || null,
    metadata_requested: body.metadata_requested === true || result?.structure_changed === true,
  }, dependencies);
}

async function enqueueQueueFinalization(env, body, observedAt, result, dependencies = EMPTY_DEPENDENCIES) {
  const metadataRequested = body.metadata_requested === true || result?.structure_changed === true;
  const continuation = {
    message_type: 'stationhead-persistence-task',
    message_version: 1,
    task: 'queue',
    stage: QUEUE_STAGE_FINALIZE,
    observed_at: observedAt,
    collector_id: body.collector_id || 'cloudflare-worker',
    data: compactMaterializationData(body.data, body.analysis),
    metadata_requested: metadataRequested,
  };
  if (metadataRequested) {
    const queue = compactMetadataQueue(body.data);
    if (queue.tracks.length) continuation.metadata_queue = queue;
  }
  return sendPersistenceContinuation(env, continuation, dependencies);
}

async function finalizeQueuePersistence(env, body, observedAt, result, dependencies = EMPTY_DEPENDENCIES) {
  const recordMaterialization = dependencies.recordQueueMaterialization || recordQueueMaterialization;
  const materializationRecorded = await recordMaterialization(
    env.DB,
    body.data,
    body.analysis,
    observedAt,
  );
  const metadataDeferred = await enqueueQueueMetadata(env, body, observedAt, result, dependencies);
  const counts = queueCounts(body.data);
  return {
    total_track_count: counts.total_track_count,
    materialized_track_count: counts.materialized_track_count,
    materialization_recorded: materializationRecorded,
    metadata_deferred: metadataDeferred,
  };
}

async function runQueueIngest(env, body, observedAt, data, dependencies) {
  const runIngest = dependencies.ingestOptimizedBody || ingestOptimizedBody;
  return runIngest(env, {
    type: 'queue',
    observed_at: observedAt,
    collector_id: body.collector_id || 'cloudflare-worker',
    data,
  });
}

export async function processPersistenceTask(env, body, dependencies = EMPTY_DEPENDENCIES) {
  const { task, observedAt, stage } = validateTask(body);
  if (!env?.DB?.prepare) throw new Error('DB binding is missing');
  if (task === 'snapshot') {
    restoreSnapshotAnalysis(body.data, body.analysis);
    const saveSnapshot = dependencies.savePreparedSnapshot || savePreparedSnapshot;
    const result = await saveSnapshot(env.DB, observedAt, body.data);
    return { task, observed_at: observedAt, ...result };
  }
  if (stage === QUEUE_STAGE_FINALIZE) {
    const finalized = await finalizeQueuePersistence(env, body, observedAt, null, dependencies);
    return {
      task,
      stage,
      observed_at: observedAt,
      ...finalized,
      finalization_deferred: false,
    };
  }

  if (stage === QUEUE_STAGE_LIKES) {
    restoreQueueAnalysis(body.data, body.analysis);
    const result = await runQueueIngest(env, body, observedAt, body.data, dependencies);
    const finalizationDeferred = await enqueueQueueFinalization(
      env,
      body,
      observedAt,
      result,
      dependencies,
    );
    if (finalizationDeferred) {
      const counts = queueCounts(body.data);
      return {
        task,
        stage,
        observed_at: observedAt,
        ...result,
        total_track_count: counts.total_track_count,
        materialized_track_count: counts.materialized_track_count,
        finalization_deferred: true,
      };
    }
    const finalized = await finalizeQueuePersistence(env, body, observedAt, result, dependencies);
    return {
      task,
      stage,
      observed_at: observedAt,
      ...result,
      ...finalized,
      finalization_deferred: false,
    };
  }

  const result = await runQueueIngest(
    env,
    body,
    observedAt,
    structuralQueueData(body.data, body.analysis),
    dependencies,
  );
  const likesDeferred = await enqueueQueueLikes(env, body, observedAt, result, dependencies);
  if (likesDeferred) {
    const counts = queueCounts(body.data);
    return {
      task,
      stage,
      observed_at: observedAt,
      ...result,
      total_track_count: counts.total_track_count,
      materialized_track_count: counts.materialized_track_count,
      likes_deferred: true,
      finalization_deferred: true,
    };
  }

  restoreQueueAnalysis(body.data, body.analysis);
  const likesResult = await runQueueIngest(env, body, observedAt, body.data, dependencies);
  const finalized = await finalizeQueuePersistence(env, body, observedAt, {
    ...likesResult,
    structure_changed: result?.structure_changed === true,
  }, dependencies);
  return {
    task,
    stage,
    observed_at: observedAt,
    ...result,
    ...likesResult,
    ...finalized,
    likes_deferred: false,
    finalization_deferred: false,
  };
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages || EMPTY_TRACKS) {
      try {
        const result = await processPersistenceTask(env, message.body, EMPTY_DEPENDENCIES);
        console.log(JSON.stringify({ event: 'persistence_task_completed', ...result }));
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({
          event: 'persistence_task_failed',
          error: String(error?.message || error).slice(0, 800),
        }));
        message.retry({ delaySeconds: 30 });
      }
    }
  },
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
