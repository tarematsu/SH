import assert from 'node:assert/strict';
import test from 'node:test';

import { isBlockedApiPath, onRequest } from '../functions/api/_middleware.js';
import { INTERNAL_API_PATHS } from '../functions/lib/api-contract.js';

const CANONICAL = [
  '/api/health',
  '/api/health/minute',
  '/api/health/other',
  '/api/health/sakurazaka46jp',
  '/api/dashboard',
  '/api/history',
  '/api/track-history',
  '/api/sakurazaka46jp',
  '/api/host-history',
];

test('Pages API has no internal HTTP implementation routes', () => {
  assert.deepEqual(INTERNAL_API_PATHS, []);
  for (const path of CANONICAL) assert.equal(isBlockedApiPath(path), false, path);
});

test('canonical API routes continue to their Pages handlers unchanged', async () => {
  for (const path of ['/api/dashboard', '/api/track-history', '/api/sakurazaka46jp']) {
    let nextCalls = 0;
    const response = await onRequest({
      request: new Request(`https://example.com${path}`),
      next: async () => {
        nextCalls += 1;
        return Response.json({ ok: true, canonical: path });
      },
    });

    assert.equal(response.status, 200);
    assert.equal(nextCalls, 1);
    assert.deepEqual(await response.json(), { ok: true, canonical: path });
  }
});
