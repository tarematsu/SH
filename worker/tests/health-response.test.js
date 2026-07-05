import assert from 'node:assert/strict';
import test from 'node:test';

import { rewriteHealthResponse } from '../src/main.js';

test('non-JSON health responses retain their original body', async () => {
  const original = new Response('upstream unavailable', {
    status: 503,
    headers: { 'content-type': 'text/plain' },
  });

  const response = await rewriteHealthResponse(original);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('content-type'), 'text/plain');
  assert.equal(await response.text(), 'upstream unavailable');
});

test('rewritten JSON health responses remove stale content length', async () => {
  const body = JSON.stringify({
    ok: true,
    cloud_solo_phase: 'idle',
    cloud_solo_session_id: 0,
    cloud_solo_station_id: 0,
  });
  const original = new Response(body, {
    headers: {
      'content-type': 'application/json',
      'content-length': String(body.length),
    },
  });

  const response = await rewriteHealthResponse(original);
  const payload = await response.json();

  assert.equal(response.headers.has('content-length'), false);
  assert.equal(payload.cloud_solo_session_id, null);
  assert.equal(payload.cloud_solo_station_id, null);
});