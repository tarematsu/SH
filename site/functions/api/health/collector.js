import { onRequestGet as collectorHealth } from '../health.js';

export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return Response.json({ ok: false, error: 'method-not-allowed' }, {
      status: 405,
      headers: { allow: 'GET' },
    });
  }
  return collectorHealth(context);
}
