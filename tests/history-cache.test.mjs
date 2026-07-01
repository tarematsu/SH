import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cachedHistoryLoad,
  cachedLegacyHistoryResponse,
  resetHistoryLoadCache,
} from '../site/functions/api/history.js';

test('history cache shares concurrent and repeated D1 work', async () => {
  resetHistoryLoadCache();
  let calls = 0;
  const loader = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { rows: [{ period_key: '2026-07-01' }] };
  };

  const [first, second] = await Promise.all([
    cachedHistoryLoad('summary:weekly', 30000, loader),
    cachedHistoryLoad('summary:weekly', 30000, loader),
  ]);
  assert.equal(calls, 1);
  assert.strictEqual(first, second);

  const third = await cachedHistoryLoad('summary:weekly', 30000, loader);
  assert.equal(calls, 1);
  assert.strictEqual(third, first);
});

test('history cache retries after a failed load', async () => {
  resetHistoryLoadCache();
  let calls = 0;
  await assert.rejects(() => cachedHistoryLoad('summary:daily', 30000, async () => {
    calls += 1;
    throw new Error('temporary');
  }));

  const value = await cachedHistoryLoad('summary:daily', 30000, async () => {
    calls += 1;
    return { rows: [] };
  });
  assert.equal(calls, 2);
  assert.deepEqual(value, { rows: [] });
});

test('ranking responses share one legacy load without reusing Response bodies', async () => {
  resetHistoryLoadCache();
  let calls = 0;
  const loader = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(JSON.stringify({ ok: true, rows: [{ rank: 1 }] }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  };

  const [first, second] = await Promise.all([
    cachedLegacyHistoryResponse('ranking:featured', 60000, loader),
    cachedLegacyHistoryResponse('ranking:featured', 60000, loader),
  ]);
  assert.equal(calls, 1);
  assert.notStrictEqual(first, second);
  assert.deepEqual(await first.json(), { ok: true, rows: [{ rank: 1 }] });
  assert.deepEqual(await second.json(), { ok: true, rows: [{ rank: 1 }] });

  const third = await cachedLegacyHistoryResponse('ranking:featured', 60000, loader);
  assert.equal(calls, 1);
  assert.deepEqual(await third.json(), { ok: true, rows: [{ rank: 1 }] });
});

test('failed ranking responses are returned but not cached', async () => {
  resetHistoryLoadCache();
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  };
  assert.equal((await cachedLegacyHistoryResponse('ranking:error', 60000, loader)).status, 500);
  assert.equal((await cachedLegacyHistoryResponse('ranking:error', 60000, loader)).status, 500);
  assert.equal(calls, 2);
});
