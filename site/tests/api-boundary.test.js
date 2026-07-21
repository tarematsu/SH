import assert from 'node:assert/strict';
import test from 'node:test';

import { isBlockedApiPath, onRequest } from '../functions/api/_middleware.js';

const INTERNAL = [
  '/api/dashboard-legacy',
  '/api/history-legacy',
  '/api/ingest',
  '/api/ingest-core',
  '/api/ingest-legacy',
  '/api/host-ingest',
  '/api/host-ingest-core',
  '/api/host-ingest-legacy',
];

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

test('internal Pages API implementation paths are blocked including trailing slashes', () => {
  for (const path of INTERNAL) {
    assert.equal(isBlockedApiPath(path), true, path);
    assert.equal(isBlockedApiPath(`${path}/`), true, `${path}/`);
  }
  for (const path of CANONICAL) assert.equal(isBlockedApiPath(path), false, path);
});

test('internal API paths return a no-store 404 before route handlers', async () => {
  for (const path of ['/api/ingest', '/api/ingest-core', '/api/host-ingest']) {
    let nextCalls = 0;
    const response = await onRequest({
      request: new Request(`https://example.com${path}`, {
        headers: { authorization: 'Bearer should-not-bypass-boundary' },
      }),
      next: async () => {
        nextCalls += 1;
        return Response.json({ ok: true });
      },
    });

    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await response.json(), { ok: false, error: 'not found' });
    assert.equal(nextCalls, 0);
  }
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
