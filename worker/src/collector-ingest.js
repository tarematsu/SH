import {
  ingestOptimizedBody,
  isPendingStreamSchemaError,
} from '../../site/functions/api/ingest.js';

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

export function ingest(env, type, data, observedAt, options = null) {
  const result = ingestOptimizedBody(env, {
    type,
    observed_at: observedAt,
    collector_id: env?.COLLECTOR_ID || 'cloudflare-worker',
    data,
  });
  if (env?.DB && (type === 'queue' || type === 'comments')) return result;
  return resolveIngestResult(result, type, options);
}