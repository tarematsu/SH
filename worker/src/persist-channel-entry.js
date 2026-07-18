import { ingestOptimizedBody } from '../../site/functions/api/ingest.js';
import { resetQueueHashCacheForTests } from '../../site/functions/lib/d1-optimized-ingest.js';
import { restoreQueueAnalysis } from './queue-analysis-transfer.js';
import { recordQueueMaterialization } from './queue-materialization.js';
import { restoreSnapshotAnalysis, savePreparedSnapshot } from './snapshot-analysis-transfer.js';

const QUEUE_STAGE_PERSIST = 'persist';
const QUEUE_STAGE_FINALIZE = 'finalize';

function validateTask(body) {
  if (body?.message_type !== 'stationhead-persistence-task'
      || Number(body?.message_version) !== 1) {
    throw new Error('unsupported persistence task');
  }
  const task = String(body.task || '');
  if (!['snapshot', 'queue'].includes(task)) throw new Error(`unsupported persistence task: ${task}`);
  const observedAt = Number(body.observed_at);
  if (!Number.isFinite(observedAt)) throw new Error('persistence observed_at is missing');
  if (!body.data || typeof body.data !== 'object') throw new Error('persistence data is missing');
  if (task !== 'queue') return { task, observedAt, stage: null };
  const stage = body.stage == null ? QUEUE_STAGE_PERSIST : String(body.stage);
  if (![QUEUE_STAGE_PERSIST, QUEUE_STAGE_FINALIZE].includes(stage)) {
    throw new Error(`unsupported persistence queue stage: ${stage}`);
  }
  return { task, observedAt, stage };
}

function queueCounts(data) {
  const trackCount = Array.isArray(data?.tracks) ? data.tracks.length : 0;
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
  const tracks = [];
  for (const track of Array.isArray(data?.tracks) ? data.tracks : []) {
    const spotifyId = track?.spotify_id ?? null;
    const isrc = track?.isrc ?? null;
    if (!spotifyId && !isrc) continue;
    tracks.push({ spotify_id: spotifyId, isrc });
  }
  return {
    station_id: data?.station_id ?? null,
    queue_id: data?.queue_id ?? null,
    start_time: data?.start_time ?? null,
    tracks,
  };
}

async function enqueueQueueMetadata(env, body, observedAt, result, dependencies = {}) {
  const requested = body.metadata_requested === true || result?.structure_changed === true;
  const queue = body.metadata_queue || body.data;
  const tracks = Array.isArray(queue?.tracks) ? queue.tracks : [];
  if (!requested || !tracks.length) return false;
  const send = dependencies.sendTrackMetadata
    || ((message) => env.TRACK_METADATA_QUEUE.send(message, { contentType: 'json' }));
  if (!dependencies.sendTrackMetadata && !env?.TRACK_METADATA_QUEUE?.send) {
    throw new Error('TRACK_METADATA_QUEUE binding is missing');
  }
  const stationId = Number(body.data?.station_id ?? queue?.station_id);
  const jobId = `queue-metadata:${Number.isFinite(stationId) ? Math.trunc(stationId) : 'unknown'}:${Math.trunc(observedAt)}`;
  await send({
    message_type: 'stationhead-track-metadata',
    message_version: 1,
    task: 'committed-enrichment',
    job: {
      jobId,
      payload: {
        observedAt,
        queue,
      },
      options: {
        enrichTrackMetadata: true,
      },
    },
  });
  return true;
}

async function enqueueQueueFinalization(env, body, observedAt, result, dependencies = {}) {
  const send = dependencies.sendPersistenceContinuation
    || (env?.PERSIST_QUEUE?.send
      ? (message) => env.PERSIST_QUEUE.send(message, { contentType: 'json' })
      : null);
  if (!send) return false;
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
  await send(continuation);
  return true;
}

async function finalizeQueuePersistence(env, body, observedAt, result, dependencies = {}) {
  const recordMaterialization = dependencies.recordQueueMaterialization || recordQueueMaterialization;
  const materializationRecorded = await recordMaterialization(
    env.DB,
    body.data,
    body.analysis,
    observedAt,
  );
  const metadataDeferred = await enqueueQueueMetadata(env, body, observedAt, result, dependencies);
  return {
    ...queueCounts(body.data),
    materialization_recorded: materializationRecorded,
    metadata_deferred: metadataDeferred,
  };
}

export async function processPersistenceTask(env, body, dependencies = {}) {
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

  restoreQueueAnalysis(body.data, body.analysis);
  // The queue hash cache predates partial materialization and its signature only
  // covers visible track fields. A changed omitted tail must force a fresh hash.
  if (body.data?.source_structural_hash) resetQueueHashCacheForTests();
  const runIngest = dependencies.ingestOptimizedBody || ingestOptimizedBody;
  const result = await runIngest(env, {
    type: 'queue',
    observed_at: observedAt,
    collector_id: body.collector_id || 'cloudflare-worker',
    data: body.data,
  });
  const finalizationDeferred = await enqueueQueueFinalization(
    env,
    body,
    observedAt,
    result,
    dependencies,
  );
  if (finalizationDeferred) {
    return {
      task,
      stage,
      observed_at: observedAt,
      ...result,
      ...queueCounts(body.data),
      finalization_deferred: true,
    };
  }

  // Keep direct callers and partially rolled-out environments compatible. The
  // production Worker always has PERSIST_QUEUE and therefore takes the split path.
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

export default {
  async queue(batch, env) {
    for (const message of batch.messages || []) {
      try {
        const result = await processPersistenceTask(env, message.body);
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
