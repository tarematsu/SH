import assert from 'node:assert/strict';
import test from 'node:test';

import { retainUncommittedRebuildCandidate } from '../src/minute-facts-backfill.js';

test('blocked rebuild candidates remain pending until a job is actually enqueued', () => {
  const candidate = { minuteAt: 120_000, snapshot: { channel_id: 10 } };
  const remaining = [];

  assert.equal(retainUncommittedRebuildCandidate({ enqueued: false }, candidate, remaining), false);
  assert.deepEqual(remaining, [candidate]);
});

test('successfully enqueued rebuild candidates are removed from pending state', () => {
  const candidate = { minuteAt: 120_000, snapshot: { channel_id: 10 } };
  const remaining = [];

  assert.equal(retainUncommittedRebuildCandidate({ enqueued: true }, candidate, remaining), true);
  assert.deepEqual(remaining, []);
});
