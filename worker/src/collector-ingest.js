import {
  ingestOptimizedBody,
  isPendingStreamSchemaError,
  onRequestPost as saveIngest,
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

  const internalSecret = env.INGEST_SECRET || 'worker-internal-ingest';
  const request = new Request('https://worker.internal/api/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${internalSecret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const response = await saveIngest({
    request,
    env: { DB: env.DB, INGEST_SECRET: internalSecret },
  });
  if (!response.ok) {
    const responseBody = await response.text().catch(() => '');
    throw new Error(`D1 ingest failed (${type}) ${response.status}: ${responseBody.slice(0, 500)}`);
  }
  const returnDetails = type === 'queue' || options.returnDetails === true;
  return returnDetails ? response.json().catch(() => ({})) : null;
}
