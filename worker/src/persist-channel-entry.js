import { ingestOptimizedBody } from '../../site/functions/api/ingest.js';
import { resetQueueHashCacheForTests } from '../../site/functions/lib/d1-optimized-ingest.js';
import { restoreQueueAnalysis } from './queue-analysis-transfer.js';
import { recordQueueMaterialization } from './queue-materialization.js';
import { restoreSnapshotAnalysis, savePreparedSnapshot } from './snapshot-analysis-transfer.js';

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
  return { task, observedAt };
}


async function enqueueQueueMetadata(env, body, observedAt, result, dependencies = {}) {
  const requested = body.metadata_requested === true || result?.structure_changed === true;
  const tracks = Array.isArray(body.data?.tracks) ? body.data.tracks : [];
  if (!requested || !tracks.length) return false;
  const send = dependencies.sendTrackMetadata
    || ((message) => env.TRACK_METADATA_QUEUE.send(message, { contentType: 'json' }));
  if (!dependencies.sendTrackMetadata && !env?.TRACK_METADATA_QUEUE?.send) {
    throw new Error('TRACK_METADATA_QUEUE binding is missing');
  }
  const stationId = Number(body.data?.station_id);
  const jobId = `queue-metadata:${Number.isFinite(stationId) ? Math.trunc(stationId) : 'unknown'}:${Math.trunc(observedAt)}`;
  await send({
    message_type: 'stationhead-track-metadata',
    message_version: 1,
    task: 'committed-enrichment',
    job: {
      jobId,
      payload: {
        observedAt,
        queue: body.data,
      },
      options: {
        enrichTrackMetadata: true,
      },
    },
  });
  return true;
}

export async function processPersistenceTask(env, body, dependencies = {}) {
  const { task, observedAt } = validateTask(body);
  if (!env?.DB?.prepare) throw new Error('DB binding is missing');
  if (task === 'snapshot') {
    restoreSnapshotAnalysis(body.data, body.analysis);
    const saveSnapshot = dependencies.savePreparedSnapshot || savePreparedSnapshot;
    const result = await saveSnapshot(env.DB, observedAt, body.data);
    return { task, observed_at: observedAt, ...result };
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
  const recordMaterialization = dependencies.recordQueueMaterialization || recordQueueMaterialization;
  const materializationRecorded = await recordMaterialization(
    env.DB,
    body.data,
    body.analysis,
    observedAt,
  );
  const metadataDeferred = await enqueueQueueMetadata(env, body, observedAt, result, dependencies);
  return {
    task,
    observed_at: observedAt,
    ...result,
    total_track_count: Number(body.data?.total_track_count || body.data?.tracks?.length || 0),
    materialized_track_count: Number(body.data?.materialized_track_count || body.data?.tracks?.length || 0),
    materialization_recorded: materializationRecorded,
    metadata_deferred: metadataDeferred,
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
