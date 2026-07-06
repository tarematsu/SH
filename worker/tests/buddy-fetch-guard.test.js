import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBuddyGuardedFetch,
  validateBuddyQueuePayload,
} from '../src/buddy-fetch-guard.js';

test('broadcasting payload must include a queue', () => {
  assert.throws(
    () => validateBuddyQueuePayload({
      alias: 'buddy46',
      current_station: { is_broadcasting: true },
    }),
    /broadcasting without a queue/,
  );
});

test('broadcasting payload must include queue tracks', () => {
  assert.throws(
    () => validateBuddyQueuePayload({
      alias: 'buddy46',
      current_station: {
        is_broadcasting: true,
        queue: { id: 99 },
      },
    }),
    /missing queue tracks/,
  );
});

test('off-air payload may omit a queue', () => {
  const payload = {
    alias: 'buddy46',
    current_station: { is_broadcasting: false },
  };
  assert.equal(validateBuddyQueuePayload(payload), payload);
});

test('guarded fetch rejects incomplete live payloads', async () => {
  const guarded = createBuddyGuardedFetch(async () => new Response(JSON.stringify({
    alias: 'buddy46',
    current_station: { is_broadcasting: true },
  }), { status: 200 }), 'buddy46');

  await assert.rejects(
    guarded('https://example.invalid/channels/alias/buddy46'),
    /broadcasting without a queue/,
  );
});

test('guarded fetch leaves unrelated requests unchanged', async () => {
  const response = new Response('{}', { status: 200 });
  const guarded = createBuddyGuardedFetch(async () => response, 'buddy46');
  assert.equal(await guarded('https://example.invalid/web/token'), response);
});
