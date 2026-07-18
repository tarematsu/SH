import { ingestOptimizedBody } from '../../site/functions/api/ingest.js';
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

export async function processPersistenceTask(env, body) {
  const { task, observedAt } = validateTask(body);
  if (!env?.DB?.prepare) throw new Error('DB binding is missing');
  if (task === 'snapshot') {
    restoreSnapshotAnalysis(body.data, body.analysis);
    const result = await savePreparedSnapshot(env.DB, observedAt, body.data);
    return { task, observed_at: observedAt, ...result };
  }
  restoreQueueAnalysis(body.data, body.analysis);
  const result = await ingestOptimizedBody(env, {
    type: 'queue',
    observed_at: observedAt,
    collector_id: body.collector_id || 'cloudflare-worker',
    data: body.data,
  });
  const materializationRecorded = await recordQueueMaterialization(
    env.DB,
    body.data,
    body.analysis,
    observedAt,
  );
  return {
    task,
    observed_at: observedAt,
    ...result,
    total_track_count: Number(body.data?.total_track_count || body.data?.tracks?.length || 0),
    materialized_track_count: Number(body.data?.materialized_track_count || body.data?.tracks?.length || 0),
    materialization_recorded: materializationRecorded,
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
