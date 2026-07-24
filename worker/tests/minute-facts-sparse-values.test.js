import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOAD_LATEST_LIVE_VALUES_SQL,
  prepareSparseLiveMinuteFact,
  resetSparseLiveValueStateForTests,
  sparseLiveValues,
} from '../src/minute-facts-sparse-values.js';

function fakeDb(row) {
  return {
    calls: [],
    prepare(sql) {
      const call = { sql: String(sql), params: [] };
      this.calls.push(call);
      return {
        bind(...params) { call.params = params; return this; },
        async first() { return row; },
      };
    },
  };
}

function fact(overrides = {}) {
  return {
    channel_id: 318,
    minute_at: 1_700_000_160_000,
    source_code: 1,
    is_broadcasting: 1,
    listener_count: 100,
    online_member_count: 25,
    guest_count: 4,
    reported_total_listens: 800_000,
    reported_current_stream_count: 50_000_000,
    comment_count: 2,
    comment_total: 10_000,
    ...overrides,
  };
}

test('same live metric and comment values are represented as sparse NULLs', () => {
  const input = fact();
  const prepared = sparseLiveValues(input, { ...input });

  assert.deepEqual(prepared.omitted.sort(), [
    'comment_count',
    'comment_total',
    'guest_count',
    'is_broadcasting',
    'listener_count',
    'online_member_count',
    'reported_current_stream_count',
    'reported_total_listens',
  ]);
  for (const field of prepared.omitted) assert.equal(prepared.fact[field], null);
});

test('changed and unavailable values are not mistaken for repeated values', () => {
  const prepared = sparseLiveValues(fact({
    listener_count: 101,
    comment_count: 3,
    comment_total: null,
  }), {
    listener_count: 100,
    comment_count: 2,
    comment_total: 10_000,
  });

  assert.equal(prepared.fact.listener_count, 101);
  assert.equal(prepared.fact.comment_count, 3);
  assert.equal(prepared.fact.comment_total, null);
  assert.equal(prepared.omitted.includes('comment_total'), false);
});

test('cold state is loaded once and committed values drive later sparsification', async () => {
  const db = fakeDb({
    minute_at: 1_700_000_100_000,
    listener_count: 100,
    comment_count: 2,
    comment_total: 10_000,
  });
  resetSparseLiveValueStateForTests(db);

  const first = await prepareSparseLiveMinuteFact(db, fact());
  assert.equal(first.fact.listener_count, null);
  assert.equal(first.fact.comment_count, null);
  assert.equal(first.fact.comment_total, null);
  assert.equal(first.fact.online_member_count, 25);
  first.commit();

  const second = await prepareSparseLiveMinuteFact(db, fact({
    minute_at: 1_700_000_220_000,
    listener_count: 101,
    comment_count: 2,
    comment_total: 10_000,
  }));
  assert.equal(second.fact.listener_count, 101);
  assert.equal(second.fact.online_member_count, null);
  assert.equal(second.fact.comment_count, null);
  assert.equal(second.fact.comment_total, null);
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].sql, LOAD_LATEST_LIVE_VALUES_SQL);
  assert.equal(db.calls[0].params.length, 9);
});

test('same-minute retries keep complete values instead of erasing the first write', async () => {
  const current = fact();
  const db = fakeDb({ minute_at: current.minute_at, listener_count: 100, comment_count: 2 });
  resetSparseLiveValueStateForTests(db);

  const prepared = await prepareSparseLiveMinuteFact(db, current);
  assert.deepEqual(prepared.omitted, []);
  assert.equal(prepared.fact.listener_count, 100);
  assert.equal(prepared.fact.comment_count, 2);
});
