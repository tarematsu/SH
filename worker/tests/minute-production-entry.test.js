import assert from 'node:assert/strict';
import test from 'node:test';

import { consumeMinuteQueue } from '../src/minute-production-entry.js';
import { minuteFactQueueMessage } from '../src/minute-facts-queue.js';

function queueMessage(body, calls) {
  return {
    body,
    attempts: 1,
    ack() { calls.push('ack'); },
    retry(options) { calls.push(['retry', options]); },
  };
}

function minuteDb(changes = () => 1, sqlCalls = []) {
  let calls = 0;
  return {
    prepare(sql) {
      sqlCalls.push(sql);
      return {
        bind() { return this; },
        async run() {
          calls += 1;
          return { meta: { changes: changes(calls) } };
        },
      };
    },
  };
}

function splitMessage(options = {}) {
  const body = minuteFactQueueMessage({
    observedAt: 123_456,
    snapshot: { channel_id: 10, station_id: 5 },
    queue: { station_id: 5, queue_id: 20, tracks: options.tracks || [] },
    comments: { commentCount: 3, commentTotal: 12, commentTotalKnown: true },
  }, options);
  body.read_model = null;
  return body;
}

test('minute ingest writes one inbox row and durably hands off one derive trigger', async () => {
  const messageCalls = [];
  const sqlCalls = [];
  const triggers = [];
  const result = await consumeMinuteQueue({
    messages: [queueMessage(splitMessage(), messageCalls)],
  }, {
    MINUTE_DB: minuteDb(() => 1, sqlCalls),
    MINUTE_DERIVE_QUEUE: {
      async send(body) { triggers.push(body); },
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
  assert.equal(sqlCalls.filter((sql) => /INSERT INTO sh_minute_fact_jobs/.test(sql)).length, 1);
  assert.deepEqual(triggers, [{
    message_type: 'minute-fact-derive',
    message_version: 1,
    job_id: 'minute-fact:10:120000',
    channel_id: 10,
    minute_at: 120_000,
  }]);
});

test('duplicate inbox delivery resends the derive trigger without extra work', async () => {
  const body = splitMessage({
    enrichTrackMetadata: true,
    tracks: [{ spotify_id: 'track-1' }],
  });
  const messageCalls = [];
  const triggers = [];
  const result = await consumeMinuteQueue({
    messages: [queueMessage(body, messageCalls), queueMessage(body, messageCalls)],
  }, {
    MINUTE_DB: minuteDb((call) => (call === 1 ? 1 : 0)),
    MINUTE_DERIVE_QUEUE: {
      async send(trigger) { triggers.push(trigger); },
    },
  }, {});

  assert.deepEqual(result, {
    received: 2,
    enqueued: 1,
    duplicates: 1,
    retried: 0,
    invalid: 0,
  });
  assert.deepEqual(messageCalls, ['ack', 'ack']);
  assert.equal(triggers.length, 2);
});

test('legacy read-model failure happens after inbox and derive handoff', async () => {
  const body = minuteFactQueueMessage({
    observedAt: 123_456,
    snapshot: { channel_id: 10, station_id: 5 },
    queue: { station_id: 5, queue_id: 20, tracks: [{ spotify_id: 'track-1' }] },
  }, {
    enrichTrackMetadata: true,
    readModel: {
      channel: { channel_id: 10, observed_at: 123_456, presentation: {} },
      queue: { station_id: 5, queue_id: 20, value: { tracks: [] } },
      collector: { collector_id: 'cloudflare-worker' },
    },
  });
  const messageCalls = [];
  let triggers = 0;
  const result = await consumeMinuteQueue({
    messages: [queueMessage(body, messageCalls)],
  }, {
    MINUTE_DB: minuteDb(),
    MINUTE_DERIVE_QUEUE: { async send() { triggers += 1; } },
  }, {}, {
    async saveMinuteFactReadModels() {
      throw new Error('legacy read model unavailable');
    },
  });

  assert.equal(result.retried, 1);
  assert.deepEqual(messageCalls, [['retry', { delaySeconds: 5 }]]);
  assert.equal(triggers, 1);
});

test('derive Queue failure retries the source message after the durable inbox insert', async () => {
  const messageCalls = [];
  const result = await consumeMinuteQueue({
    messages: [queueMessage(splitMessage(), messageCalls)],
  }, {
    MINUTE_DB: minuteDb(),
    MINUTE_DERIVE_QUEUE: {
      async send() { throw new Error('derive queue unavailable'); },
    },
  }, {});

  assert.equal(result.retried, 1);
  assert.deepEqual(messageCalls, [['retry', { delaySeconds: 5 }]]);
});
