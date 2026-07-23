import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveDispatchStateCheckpointDue,
  dispatchPendingMinuteFacts,
} from '../src/minute-maintenance-entry.js';
import { minuteFactInboxHealth } from '../src/minute-facts-inbox-health.js';
import { MINUTE_FACT_INBOX_STATS_SQL } from '../src/minute-facts-inbox.js';

const MINUTE_MS = 60_000;

function idleDependencies(now, calls) {
  return {
    now,
    load: async () => [],
    loadRevisionRecovery: async () => [],
    stats: async () => {
      calls.push('stats');
      return { pending_count: 0, processing_count: 0, dead_count: 0 };
    },
    record: async () => { calls.push('record'); },
  };
}

test('idle recovery polls sample and persist health only once per twenty-minute window', async () => {
  assert.equal(deriveDispatchStateCheckpointDue(6 * MINUTE_MS), false);
  assert.equal(deriveDispatchStateCheckpointDue(21 * MINUTE_MS), true);

  const calls = [];
  const env = {
    MINUTE_DB: {},
    MINUTE_DERIVE_QUEUE: { async send() {} },
  };
  const skipped = await dispatchPendingMinuteFacts(env, idleDependencies(6 * MINUTE_MS, calls));
  assert.equal(skipped.state_checkpoint_skipped, true);
  assert.deepEqual(calls, []);

  const checkpoint = await dispatchPendingMinuteFacts(env, idleDependencies(21 * MINUTE_MS, calls));
  assert.equal(checkpoint.state_checkpoint_skipped, undefined);
  assert.deepEqual(calls, ['stats', 'record']);
});

test('dispatched work refreshes health immediately outside the checkpoint slot', async () => {
  const calls = [];
  const trigger = { message_type: 'minute-fact-derive', job_kind: 'live' };
  const sent = [];
  const summary = await dispatchPendingMinuteFacts({
    MINUTE_DB: {},
    MINUTE_DERIVE_QUEUE: { async send(body) { sent.push(body); } },
  }, {
    now: 6 * MINUTE_MS,
    load: async () => [trigger],
    loadRevisionRecovery: async () => [],
    stats: async () => { calls.push('stats'); return { pending_count: 1 }; },
    record: async () => { calls.push('record'); },
  });
  assert.deepEqual(sent, [trigger]);
  assert.deepEqual(calls, ['stats', 'record']);
  assert.equal(summary.pending_count, 1);
});

test('minute inbox health delegates to the single persisted counter row', async () => {
  let sql = '';
  const result = await minuteFactInboxHealth({
    MINUTE_DB: {
      prepare(value) {
        sql = value;
        return {
          async first() {
            return {
              pending_count: 2,
              processing_count: 1,
              dead_count: 0,
              rebuild_pending_count: 1,
              live_pending_count: 1,
              oldest_pending_minute: 60_000,
            };
          },
        };
      },
    },
  });
  assert.equal(result.pending_count, 2);
  assert.equal(sql, MINUTE_FACT_INBOX_STATS_SQL);
  assert.match(sql, /FROM sh_minute_fact_inbox_stats/);
  assert.doesNotMatch(sql, /COUNT\(\*\)|MIN\(minute_at\)/);
});
