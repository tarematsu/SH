import {
  ingestOptimizedBody,
  isPendingStreamSchemaError,
} from '../../site/functions/api/ingest.js';
import { savePreparedSnapshot } from './snapshot-analysis-transfer.js';

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

function optimizedIngest(env, type, data, observedAt) {
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
