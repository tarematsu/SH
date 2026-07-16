import assert from 'node:assert/strict';
import test from 'node:test';

import { consumeMinuteQueue } from '../src/minute-production-entry.js';
import { minuteFactQueueMessage } from '../src/minute-facts-queue.js';

test('production minute consumer acknowledges split-pipeline messages without read-model writes', async () => {
  const body = minuteFactQueueMessage({
    observedAt: 123_456,
    snapshot: { channel_id: 10, station_id: 5 },
    queue: { station_id: 5, queue_id: 20, tracks: [] },
  });
  body.read_model = null;

  const messageCalls = [];
  const sqlCalls = [];
  const result = await consumeMinuteQueue({
    messages: [{
      body,
      attempts: 1,
      ack() { messageCalls.push('ack'); },
      retry() { messageCalls.push('retry'); },
    }],
  }, {
    MINUTE_DB: {
      prepare(sql) {
        sqlCalls.push(sql);
        return {
          bind() { return this; },
          async run() { return { meta: { changes: 1 } }; },
        };
      },
    },
  }, {});

  assert.deepEqual(result, {
    received: 1,
    enqueued: 1,
    duplicates: 0,
    retried: 0,
    invalid: 0,
  });
  assert.deepEqual(messageCalls, ['ack']);
  assert.equal(sqlCalls.length, 1);
  assert.match(sqlCalls[0], /INSERT INTO sh_minute_fact_jobs/);
});
