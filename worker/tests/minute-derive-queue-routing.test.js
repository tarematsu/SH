import assert from 'node:assert/strict';
import test from 'node:test';

import { enqueueMinuteDeriveTrigger } from '../src/minute-derive-trigger.js';
import {
  LIVE_DERIVE_QUEUE_NAME,
  REBUILD_DERIVE_QUEUE_NAME,
  processMinutePipelineBatch,
} from '../src/minute-pipeline-entry.js';
import { lightweightLiveBudgetKind } from '../src/runtime-orchestrator-entry.js';

function input(jobKind) {
  return {
    channel_id: 42,
    minute_at: 1_700_000_000_000,
    job_kind: jobKind,
  };
}

function trigger(jobKind) {
  return {
    message_type: 'minute-fact-derive',
    message_version: 1,
    job_id: 'minute-fact:42:1700000000000',
    ...input(jobKind),
  };
}

test('derive trigger enqueue selects the Queue from job kind', async () => {
  const sent = [];
  const env = {
    MINUTE_LIVE_DERIVE_QUEUE: {
      async send(body, options) { sent.push(['live', body, options]); },
    },
    MINUTE_DERIVE_QUEUE: {
      async send(body, options) { sent.push(['rebuild', body, options]); },
    },
  };

  await enqueueMinuteDeriveTrigger(env, input('live'));
  await enqueueMinuteDeriveTrigger(env, input('rebuild'));

  assert.deepEqual(sent.map(([queue, body]) => [queue, body.job_kind]), [
    ['live', 'live'],
    ['rebuild', 'rebuild'],
  ]);
  assert.deepEqual(sent.map(([, , options]) => options), [
    { contentType: 'json' },
    { contentType: 'json' },
  ]);
});

test('rebuild enqueue never falls back to the live Queue', async () => {
  let liveSends = 0;
  await assert.rejects(
    enqueueMinuteDeriveTrigger({
      MINUTE_LIVE_DERIVE_QUEUE: { async send() { liveSends += 1; } },
    }, input('rebuild')),
    /minute rebuild derive Queue binding is missing/,
  );
  assert.equal(liveSends, 0);
});

test('rebuild triggers are excluded from the lightweight live classifier', () => {
  const batch = { queue: LIVE_DERIVE_QUEUE_NAME, messages: [{ body: trigger('rebuild') }] };
  assert.equal(lightweightLiveBudgetKind(batch, {
    LIVE_REVISION_MATERIALIZATION_ENABLED: false,
  }), null);
});

test('stale rebuild triggers on the live Queue respect the rebuild policy', async () => {
  const events = [];
  await processMinutePipelineBatch({
    queue: LIVE_DERIVE_QUEUE_NAME,
    messages: [{
      body: trigger('rebuild'),
      ack() { events.push('ack'); },
    }],
  }, { HISTORICAL_REBUILD_ENABLED: false }, {}, {
    async processMinuteDeriveBatch() { events.push('derive'); },
  });
  assert.deepEqual(events, ['ack']);
});

test('enabled stale rebuild triggers are normalized to the rebuild Queue', async () => {
  let routedQueue = null;
  await processMinutePipelineBatch({
    queue: LIVE_DERIVE_QUEUE_NAME,
    messages: [{ body: trigger('rebuild') }],
  }, { HISTORICAL_REBUILD_ENABLED: true }, {}, {
    async processMinuteDeriveBatch(batch) { routedQueue = batch.queue; },
  });
  assert.equal(routedQueue, REBUILD_DERIVE_QUEUE_NAME);
});
