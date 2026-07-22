import { ingestOptimizedBody } from '../../site/functions/lib/ingest.js';
import { serializedQueueAnalysis } from './queue-analysis-transfer.js';
import { savePreparedSnapshot } from './snapshot-analysis-transfer.js';

const SNAPSHOT_ANALYSIS = Symbol.for('stationhead.snapshot.analysis');
const MINUTE_MS = 60_000;

function snapshotPersistenceIntervalMs(env) {
  const parsed = Number(env?.SNAPSHOT_PERSIST_INTERVAL_MS);
  if (!Number.isFinite(parsed) || parsed < MINUTE_MS) return MINUTE_MS;
  return Math.min(Math.trunc(parsed), 60 * MINUTE_MS);
}

export function snapshotPersistenceDue(env, observedAt) {
  const interval = snapshotPersistenceIntervalMs(env);
  if (interval <= MINUTE_MS) return true;
  const timestamp = Number(observedAt);
  if (!Number.isFinite(timestamp) || timestamp < 0) return true;
  return Math.floor(timestamp / interval) !== Math.floor((timestamp - MINUTE_MS) / interval);
}

async function resolveIngestResult(result, type, options) {
  const directResult = await result;
  if (!directResult) throw new Error(`Direct D1 ingest is unavailable for type=${type}`);
  return options?.returnDetails === true ? directResult : null;
}

async function deferPersistence(env, type, data, observedAt, options = null) {
  if (!env?.PERSIST_QUEUE?.send || !['snapshot', 'queue'].includes(type)) return null;
  if (type === 'snapshot' && !snapshotPersistenceDue(env, observedAt)) {
    return {
      ok: true,
      type,
      accepted: true,
      deferred: false,
      inserted: false,
      skipped: true,
      reason: 'snapshot-persistence-not-due',
    };
  }
  const collectorId = env?.COLLECTOR_ID || 'cloudflare-worker';
  let analysis = null;
  if (type === 'snapshot') analysis = data?.[SNAPSHOT_ANALYSIS] || null;
  if (type === 'queue') analysis = serializedQueueAnalysis(data);
  await env.PERSIST_QUEUE.send({
    message_type: 'stationhead-persistence-task',
    message_version: 1,
    task: type,
    observed_at: observedAt,
    collector_id: collectorId,
    data,
    analysis,
    metadata_requested: type === 'queue' && options?.metadataRequested === true,
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
    structure_changed: false,
    likes_changed: false,
    queue_items_written: 0,
    like_observations_written: 0,
  };
}

async function optimizedIngest(env, type, data, observedAt, options = null) {
  const deferred = await deferPersistence(env, type, data, observedAt, options);
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
  const result = optimizedIngest(env, type, data, observedAt, options);
  if (env?.DB && (type === 'queue' || type === 'comments')) return result;
  return resolveIngestResult(result, type, options);
}
