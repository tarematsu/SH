import {
  ingestOptimizedBody,
  isPendingStreamSchemaError,
} from '../../site/functions/api/ingest.js';
import { serializedQueueAnalysis } from './queue-analysis-transfer.js';
import { savePreparedSnapshot } from './snapshot-analysis-transfer.js';

const SNAPSHOT_ANALYSIS = Symbol.for('stationhead.snapshot.analysis');

async function resolveIngestResult(result, type, options) {
  let directResult = null;
  try {
    directResult = await result;
  } catch (error) {
    if (type !== 'snapshot' || !isPendingStreamSchemaError(error)) throw error;
  }

  if (!directResult) {
    throw new Error(`Direct D1 ingest is unavailable for type=${type}`);
  }
  return options?.returnDetails === true ? directResult : null;
}

async function queueChangeState(env, data, analysis) {
  const stationId = Number(data?.station_id);
  if (!Number.isFinite(stationId) || !analysis?.structural_hash) {
    return { structureChanged: false, likesChanged: false };
  }
  const current = await env.DB.prepare(`SELECT structural_hash,likes_hash
    FROM sh_queue_current WHERE station_id IS ?`).bind(stationId).first();
  return {
    structureChanged: current?.structural_hash !== analysis.structural_hash,
    likesChanged: Boolean(analysis.likes_hash && current?.likes_hash !== analysis.likes_hash),
  };
}

async function deferPersistence(env, type, data, observedAt) {
  if (!env?.PERSIST_QUEUE?.send || !['snapshot', 'queue'].includes(type)) return null;
  const collectorId = env?.COLLECTOR_ID || 'cloudflare-worker';
  let analysis = null;
  let changes = { structureChanged: false, likesChanged: false };
  if (type === 'snapshot') analysis = data?.[SNAPSHOT_ANALYSIS] || null;
  if (type === 'queue') {
    analysis = serializedQueueAnalysis(data);
    changes = await queueChangeState(env, data, analysis);
  }
  await env.PERSIST_QUEUE.send({
    message_type: 'stationhead-persistence-task',
    message_version: 1,
    task: type,
    observed_at: observedAt,
    collector_id: collectorId,
    data,
    analysis,
  }, { contentType: 'json' });
  if (type === 'snapshot') {
    return { ok: true, type, accepted: true, deferred: true, inserted: false, skipped: false };
  }
  return {
    ok: true,
    type,
    accepted: true,
    deferred: true,
    queue_inspected: false,
    structure_changed: changes.structureChanged,
    likes_changed: changes.likesChanged,
    queue_items_written: 0,
    like_observations_written: 0,
  };
}

async function optimizedIngest(env, type, data, observedAt) {
  const deferred = await deferPersistence(env, type, data, observedAt);
  if (deferred) return deferred;
  if (type === 'snapshot' && env?.DB) {
    return savePreparedSnapshot(env.DB, observedAt, data).then((details) => ({
      ok: true,
      type,
      accepted: true,
      ...details,
    }));
  }
  return ingestOptimizedBody(env, {
    type,
    observed_at: observedAt,
    collector_id: env?.COLLECTOR_ID || 'cloudflare-worker',
    data,
  });
}

export function ingest(env, type, data, observedAt, options = null) {
  const result = optimizedIngest(env, type, data, observedAt);
  if (env?.DB && (type === 'queue' || type === 'comments')) return result;
  return resolveIngestResult(result, type, options);
}
