export { onRequestGet } from '../health.js';

export async function onRequest() {
  return Response.json({ ok: false, error: 'method-not-allowed' }, {
    status: 405,
    headers: { allow: 'GET' },
  });
}
