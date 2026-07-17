import {
  ingestOptimizedBody,
  isPendingStreamSchemaError,
  supportsOptimizedIngestType,
} from '../../site/functions/api/ingest.js';

export async function ingest(env, type, data, observedAt, options = null) {
  if (!supportsOptimizedIngestType(type)) {
    throw new Error(`Direct D1 ingest is unavailable for type=${type}`);
  }

  let directResult = null;
  try {
    directResult = await ingestOptimizedBody(env, {
      type,
      observed_at: observedAt,
      collector_id: env.COLLECTOR_ID || 'cloudflare-worker',
      data,
    });
  } catch (error) {
    if (type !== 'snapshot' || !isPendingStreamSchemaError(error)) throw error;
  }

  if (!directResult) {
    throw new Error(`Direct D1 ingest is unavailable for type=${type}`);
  }
  const returnDetails = type === 'queue'
    || type === 'comments'
    || options?.returnDetails === true;
  return returnDetails ? directResult : null;
}
