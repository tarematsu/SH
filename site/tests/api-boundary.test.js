import assert from 'node:assert/strict';
import test from 'node:test';

import { isBlockedApiPath, onRequest } from '../functions/api/_middleware.js';

const BLOCKED = [
  '/api/health/collector',
  '/api/history-current',
  '/api/history-migrated',
  '/api/history-raw',
  '/api/official-history',
  '/api/dashboard-legacy',
  '/api/history-legacy',
  '/api/ingest',
  '/api/ingest-core',
  '/api/ingest-legacy',
  '/api/host-ingest',
  '/api/host-ingest-core',
  '/api/host-ingest-legacy',
];

test('internal and retired Pages API paths are blocked including trailing slashes', () => {
  for (const path of BLOCKED) {
    assert.equal(isBlockedApiPath(path), true, path);
    assert.equal(isBlockedApiPath(`${path}/`), true, `${path}/`);
  }
  assert.equal(isBlockedApiPath('/api/dashboard'), false);
  assert.equal(isBlockedApiPath('/api/minute-facts'), false);
  assert.equal(isBlockedApiPath('/api/minute-facts/current'), false);
});

test('blocked API paths return a no-store 404 before route handlers', async () => {
  for (const path of ['/api/ingest-core', '/api/history-current', '/api/official-history']) {
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

test('canonical uncached API routes continue to their Pages handler unchanged', async () => {
  let nextCalls = 0;
  const response = await onRequest({
    request: new Request('https://example.com/api/minute-facts?limit=20'),
    next: async () => {
      nextCalls += 1;
      return Response.json({ ok: true, canonical: true });
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('deprecation'), null);
  assert.equal(nextCalls, 1);
  assert.deepEqual(await response.json(), { ok: true, canonical: true });
});
