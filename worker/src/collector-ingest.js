import {
  ingestOptimizedBody,
  isPendingStreamSchemaError,
  supportsOptimizedIngestType,
} from '../../site/functions/api/ingest.js';

function ingestBody(env, type, data, observedAt) {
  return {
    type,
    observed_at: observedAt,
    collector_id: env.COLLECTOR_ID || 'cloudflare-worker',
    data,
  };
}

async function directIngest(env, body) {
  if (!supportsOptimizedIngestType(body.type)) return null;
  try {
    return await ingestOptimizedBody(env, body);
  } catch (error) {
    if (body.type === 'snapshot' && isPendingStreamSchemaError(error)) return null;
    throw error;
  }
}

export async function ingest(env, type, data, observedAt, options = {}) {
  const body = ingestBody(env, type, data, observedAt);
  const directResult = await directIngest(env, body);
  if (directResult) {
    const returnDetails = type === 'queue' || options.returnDetails === true;
    return returnDetails ? directResult : null;
  }

  throw new Error(`Direct D1 ingest is unavailable for type=${type}`);
}
