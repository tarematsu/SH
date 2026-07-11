import { onRequestPost as saveIngest } from '../../site/functions/api/ingest.js';

export async function ingest(env, type, data, observedAt) {
  const internalSecret = env.INGEST_SECRET || 'worker-internal-ingest';
  const request = new Request('https://worker.internal/api/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${internalSecret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      type,
      observed_at: observedAt,
      collector_id: env.COLLECTOR_ID || 'cloudflare-worker',
      data,
    }),
  });
  const response = await saveIngest({
    request,
    env: { DB: env.DB, INGEST_SECRET: internalSecret },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`D1 ingest failed (${type}) ${response.status}: ${body.slice(0, 500)}`);
  }
  return type === 'queue' ? response.json().catch(() => ({})) : null;
}
