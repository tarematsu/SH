import assert from 'node:assert/strict';
import test from 'node:test';

import { runPagesReadModelFetch } from '../src/pages-read-model-entry.js';

test('internal fetch delegates one KV response load and returns it', async () => {
  const now = Date.UTC(2026, 6, 20, 0, 0);
  const calls = [];
  const response = await runPagesReadModelFetch(
    new Request('https://internal.test/_internal/pages-response?key=history%3Adaily'),
    { PAGES_RESPONSE_KV: { name: 'kv' } },
    {
      now: () => now,
      loadResponse: async (...args) => {
        calls.push(args);
        return Response.json({ ok: true });
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'history:daily');
  assert.equal(calls[0][2], now);
  assert.equal(calls[0][3], 21_900_000);
});

test('missing and failed KV entries fail closed for the Pages D1 fallback', async () => {
  const missing = await runPagesReadModelFetch(
    new Request('https://internal.test/_internal/pages-response?key=history%3Adaily'),
    {},
    { loadResponse: async () => null },
  );
  assert.equal(missing.status, 404);

  const failed = await runPagesReadModelFetch(
    new Request('https://internal.test/_internal/pages-response?key=history%3Adaily'),
    {},
    { loadResponse: async () => { throw new Error('quota'); } },
  );
  assert.equal(failed.status, 503);
});
