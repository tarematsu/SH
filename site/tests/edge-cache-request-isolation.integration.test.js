import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequest as rootMiddleware } from '../functions/_middleware.js';
import { onRequest as apiMiddleware } from '../functions/api/_middleware.js';
import { serveCached as legacyMiddleware } from '../functions/lib/cache-middleware.js';

function uncachedEdge() {
  return {
    async match() { return undefined; },
    async put() {},
  };
}

async function assertConcurrentMissesStayRequestLocal(handler, url) {
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: uncachedEdge() };
  const releases = [];
  let builds = 0;

  const invoke = () => handler({
    request: new Request(url),
    env: {},
    next() {
      const build = ++builds;
      return new Promise((resolve) => releases.push(() => resolve(Response.json({ build }))));
    },
    waitUntil() {},
  });

  try {
    const firstPromise = invoke();
    const secondPromise = invoke();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(builds, 2, 'concurrent misses must not share a context.next() promise');

    releases[0]();
    releases[1]();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(first.headers.get('x-edge-cache'), 'MISS');
    assert.equal(second.headers.get('x-edge-cache'), 'MISS');
    assert.deepEqual(await first.json(), { build: 1 });
    assert.deepEqual(await second.json(), { build: 2 });
  } finally {
    globalThis.caches = previousCaches;
  }
}

test('root Pages cache does not share Response promises across requests', async () => {
  await assertConcurrentMissesStayRequestLocal(
    rootMiddleware,
    'https://skrzk.test/api/broadcast-series?id=7',
  );
});

test('API cache does not share Response promises across requests', async () => {
  await assertConcurrentMissesStayRequestLocal(
    apiMiddleware,
    'https://skrzk.test/api/broadcast-series?id=7',
  );
});

test('legacy cache helper does not share Response promises across requests', async () => {
  await assertConcurrentMissesStayRequestLocal(
    legacyMiddleware,
    'https://skrzk.test/api/broadcast-series?id=7',
  );
});
