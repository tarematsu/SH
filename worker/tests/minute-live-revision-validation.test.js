import assert from 'node:assert/strict';
import test from 'node:test';

import {
  budgetedLiveRevisionMessage,
  processBudgetedLiveRevisionBatch,
} from '../src/minute-live-revision-budget-entry.js';
import { lightweightLiveBudgetKind } from '../src/runtime-orchestrator-entry.js';

function body(revisionId = 7) {
  return {
    message_type: 'minute-fact-derive-stage',
    message_version: 1,
    stage: 'revision-materialize',
    revision: {
      revision_id: revisionId,
      sparse: true,
      rebuild: false,
    },
  };
}

function message(value, events) {
  return {
    body: value,
    ack() { events.push('ack'); },
    retry(options) { events.push(['retry', options]); },
  };
}

test('budgeted revision requires a positive revision identity', () => {
  assert.equal(budgetedLiveRevisionMessage(body()), true);
  assert.equal(budgetedLiveRevisionMessage(body(null)), false);
  assert.equal(budgetedLiveRevisionMessage(body(0)), false);
  assert.equal(lightweightLiveBudgetKind({
    queue: 'stationhead-minute-live-derive',
    messages: [{ body: body(null) }],
  }, { LIVE_REVISION_MATERIALIZATION_ENABLED: false }), null);
});

test('valid revision closes the bounded partial revision row', async () => {
  const calls = [];
  const statement = {
    bind(...values) { calls.push(['bind', values]); return this; },
    async run() { calls.push(['run']); return { meta: { changes: 1 } }; },
  };
  const events = [];
  await processBudgetedLiveRevisionBatch({ messages: [message(body(), events)] }, {
    MINUTE_DB: {
      prepare(sql) { calls.push(['sql', sql]); return statement; },
    },
  }, { now: () => 500 });
  assert.deepEqual(events, ['ack']);
  assert.match(calls[0][1], /UPDATE sh_queue_revisions/);
  assert.deepEqual(calls[1], ['bind', [500, 7]]);
});

test('malformed revision is acknowledged without retrying poison input', async () => {
  const events = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    await processBudgetedLiveRevisionBatch({ messages: [message(body(null), events)] }, {});
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(events, ['ack']);
});

test('missing D1 binding remains a retryable operational failure', async () => {
  const events = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    await processBudgetedLiveRevisionBatch({ messages: [message(body(), events)] }, {});
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(events, [['retry', { delaySeconds: 60 }]]);
});
