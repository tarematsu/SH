import assert from 'node:assert/strict';
import test from 'node:test';

import { consumeMinuteQueue } from '../src/minute-production-entry.js';
import { minuteFactQueueMessage } from '../src/minute-facts-queue.js';

function queueMessage(body, calls) {
  return {
    body,
    attempts: 1,
    ack() { calls.push('ack'); },
    retry() { calls.push('retry'); },
  };
}

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
    messages: [queueMessage(body, messageCalls)],
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

test('production minute consumer enriches one accepted job only once within a duplicate batch', async () => {
  const body = minuteFactQueueMessage({
    observedAt: 123_456,
    snapshot: { channel_id: 10, station_id: 5 },
    queue: { station_id: 5, queue_id: 20, tracks: [{ spotify_id: 'track-1' }] },
  }, { enrichTrackMetadata: true });
  body.read_model = null;

  const messageCalls = [];
  const tasks = [];
  const enrichedJobs = [];
  let inserts = 0;
  const result = await consumeMinuteQueue({
    messages: [queueMessage(body, messageCalls), queueMessage(body, messageCalls)],
  }, {
    MINUTE_DB: {
      prepare() {
        return {
          bind() { return this; },
          async run() {
            inserts += 1;
            return { meta: { changes: inserts === 1 ? 1 : 0 } };
          },
        };
      },
    },
  }, {
    waitUntil(task) { tasks.push(task); },
  }, {
    async runCommittedMetadataEnrichment(_env, jobs) {
      enrichedJobs.push(...jobs);
    },
  });
  await Promise.all(tasks);

  assert.deepEqual(result, {
    received: 2,
    enqueued: 1,
    duplicates: 1,
    retried: 0,
    invalid: 0,
  });
  assert.deepEqual(messageCalls, ['ack', 'ack']);
  assert.equal(enrichedJobs.length, 1);
  assert.equal(enrichedJobs[0].jobId, 'minute-fact:10:120000');
});