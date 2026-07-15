import assert from 'node:assert/strict';
import test from 'node:test';

import minuteApp, { runCommittedMetadataEnrichment } from '../src/minute-entry.js';
import { saveMinuteFactReadModels } from '../src/minute-facts-read-model.js';
import {
  consumeMinuteFactBatch,
  flushMinuteFactOutbox,
  handoffMinuteFactJob,
  MINUTE_FACT_QUEUE_MAX_MESSAGE_BYTES,
  minuteFactQueueMessage,
  parseMinuteFactQueueMessage,
  sendMinuteFactJob,
} from '../src/minute-facts-queue.js';

const input = {
  observedAt: 123_456,
  snapshot: { channel_id: 10, listener_count: 42 },
  queue: { queue_id: 20, tracks: [] },
  comments: { commentCount: 3 },
};

function queueMessage(body, attempts = 1) {
  const calls = [];
  return {
    id: `message-${attempts}`,
    attempts,
    body,
    calls,
    ack() { calls.push(['ack']); },
    retry(options) { calls.push(['retry', options]); },
  };
}

function outboxDb() {
  const rows = new Map();
  const calls = [];
  return {
    rows,
    calls,
    prepare(sql) {
      calls.push(sql);
      const statement = {
        params: [],
        bind(...params) { this.params = params; return this; },
        async run() {
          if (sql.includes('CREATE TABLE')) return { meta: { changes: 0 } };
          if (sql.includes('INSERT OR IGNORE INTO sh_minute_fact_outbox')) {
            const [jobId, payloadJson, createdAt] = this.params;
            if (!rows.has(jobId)) rows.set(jobId, { job_id: jobId, payload_json: payloadJson, status: 'pending', attempts: 0, created_at: createdAt });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('DELETE FROM sh_minute_fact_outbox')) return { meta: { changes: 0 } };
          if (sql.includes("SET\n          status='sent'")) {
            const [sentAt, lastAttemptAt, jobId] = this.params;
            Object.assign(rows.get(jobId), { status: 'sent', payload_json: '{}', sent_at: sentAt, last_attempt_at: lastAttemptAt, attempts: rows.get(jobId).attempts + 1 });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('attempts=attempts+1')) {
            const [lastAttemptAt, lastError, jobId] = this.params;
            Object.assign(rows.get(jobId), { last_attempt_at: lastAttemptAt, last_error: lastError, attempts: rows.get(jobId).attempts + 1 });
            return { meta: { changes: 1 } };
          }
          throw new Error(`unexpected run: ${sql}`);
        },
        async all() {
          if (sql.includes("WHERE status='pending'")) {
            const [inlineMessageJobId, limit] = this.params;
            return {
              results: [...rows.values()]
                .filter((row) => row.status === 'pending')
                .slice(0, limit)
                .map((row) => row.job_id === inlineMessageJobId
                  ? { ...row, payload_json: null }
                  : row),
            };
          }
          throw new Error(`unexpected all: ${sql}`);
        },
        async first() {
          if (sql.includes('COUNT(*)')) return { count: [...rows.values()].filter((row) => row.status === 'pending').length };
          if (sql.includes('WHERE job_id=?')) return rows.get(this.params[0]) || null;
          throw new Error(`unexpected first: ${sql}`);
        },
      };
      return statement;
    },
  };
}

test('producer awaits durable Queue acceptance without touching MINUTE_DB', async () => {
  let accepted = false;
  let sent;
  const env = {
    MINUTE_DB: new Proxy({}, {
      get() { throw new Error('MINUTE_DB must not be touched by producer'); },
    }),
    MINUTE_FACT_QUEUE: {
      async send(body, options) {
        await Promise.resolve();
        sent = { body, options };
        accepted = true;
      },
    },
  };

  const result = await sendMinuteFactJob(env, input, {
    enrichTrackMetadata: true,
    collectComments: true,
  });

  assert.equal(accepted, true);
  assert.equal(result.enqueued, true);
  assert.equal(result.channel_id, 10);
  assert.equal(result.minute_at, 120_000);
  assert.equal(sent.options.contentType, 'json');
  const parsed = parseMinuteFactQueueMessage(sent.body);
  assert.equal(parsed.options.enrichTrackMetadata, true);
  assert.equal(parsed.options.collectComments, true);
  assert.deepEqual(parsed.payload, {
    payload_version: 1,
    observedAt: 123_456,
    snapshot: input.snapshot,
    queue: input.queue,
    comments: input.comments,
    rebuild: null,
  });
});

test('producer does not report success before Queue send resolves', async () => {
  let resolveSend;
  const pending = sendMinuteFactJob({
    MINUTE_FACT_QUEUE: {
      send() { return new Promise((resolve) => { resolveSend = resolve; }); },
    },
  }, input);
  let settled = false;
  pending.finally(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  resolveSend();
  await pending;
  assert.equal(settled, true);
});

test('outbox reuses the current in-memory message instead of row payload JSON', async () => {
  const DB = outboxDb();
  let sent = null;
  const env = {
    DB,
    MINUTE_FACT_QUEUE: {
      async send(message) { sent = message; },
    },
  };

  const result = await handoffMinuteFactJob(env, input);

  assert.equal(result.enqueued, true);
  assert.equal(sent?.job_id, 'minute-fact:10:120000');
  assert.equal(DB.calls.some((sql) => sql.includes('CASE WHEN job_id=? THEN NULL')), true);
  assert.equal(DB.rows.get(sent.job_id).status, 'sent');
});

test('outbox loads serialized payload when no current message is supplied', async () => {
  const DB = outboxDb();
  const message = minuteFactQueueMessage(input);
  DB.rows.set(message.job_id, {
    job_id: message.job_id,
    payload_json: JSON.stringify(message),
    status: 'pending',
    attempts: 0,
    created_at: 123,
  });
  let sent = null;
  const result = await flushMinuteFactOutbox({
    DB,
    MINUTE_FACT_QUEUE: {
      async send(value) { sent = value; },
    },
  }, { currentJobId: message.job_id });

  assert.equal(result.sent, 1);
  assert.equal(sent?.job_id, message.job_id);
  assert.equal(DB.calls.some((sql) => sql.includes('CASE WHEN job_id=? THEN NULL')), true);
});

test('outbox keeps a failed Queue delivery pending and retries it on the next collection', async () => {
  const DB = outboxDb();
  let attempts = 0;
  const env = {
    DB,
    MINUTE_FACT_QUEUE: {
      async send() {
        attempts += 1;
        if (attempts === 1) throw new Error('Queue unavailable');
      },
    },
  };

  const first = await handoffMinuteFactJob(env, input);
  assert.equal(first.enqueued, false);
  assert.equal(first.outbox_pending, true);
  assert.equal([...DB.rows.values()][0].status, 'pending');
  const originalPayload = [...DB.rows.values()][0].payload_json;
  assert.notEqual(originalPayload, '{}');

  const second = await handoffMinuteFactJob(env, input);
  assert.equal(second.enqueued, true);
  assert.equal(second.outbox_pending, false);
  assert.equal([...DB.rows.values()][0].status, 'sent');
  assert.equal([...DB.rows.values()][0].payload_json, '{}');
  assert.equal(attempts, 2);
  assert.equal(DB.calls.some((sql) => sql.includes('CREATE TABLE')), false);
  assert.equal(DB.calls.some((sql) => sql.includes('SELECT COUNT(*) AS count')), false);
  assert.equal(DB.calls.some((sql) => sql.includes('SELECT status FROM sh_minute_fact_outbox')), false);
});

test('consumer enqueues once and acknowledges duplicate at-least-once delivery', async () => {
  const body = minuteFactQueueMessage(input);
  const first = queueMessage(body);
  const duplicate = queueMessage(body, 2);
  let calls = 0;
  const result = await consumeMinuteFactBatch({ messages: [first, duplicate] }, { MINUTE_DB: {} }, {
    enqueue: async (_env, payload) => {
      calls += 1;
      assert.equal(payload.snapshot.channel_id, 10);
      return { enqueued: calls === 1 };
    },
  });

  assert.deepEqual(result, { received: 2, enqueued: 1, duplicates: 1, retried: 0, invalid: 0 });
  assert.deepEqual(first.calls, [['ack']]);
  assert.deepEqual(duplicate.calls, [['ack']]);
});

test('consumer emits optional work only after the durable commit and acknowledgement', async () => {
  const calls = [];
  const body = minuteFactQueueMessage(input, {
    enrichTrackMetadata: true,
    collectComments: true,
  });
  const message = {
    body,
    attempts: 1,
    ack() { calls.push('ack'); },
    retry() { calls.push('retry'); },
  };
  await consumeMinuteFactBatch({ messages: [message] }, {}, {
    hasReceipt: async () => false,
    enqueue: async () => { calls.push('enqueue'); return { enqueued: true }; },
    saveReadModels: async () => { calls.push('read_model'); },
    saveCommentTask: async () => { calls.push('comment_task'); },
    saveReceipt: async () => { calls.push('receipt'); },
    onCommitted(job) {
      calls.push(`committed:${job.options.enrichTrackMetadata}`);
    },
  });

  assert.deepEqual(calls, ['enqueue', 'read_model', 'comment_task', 'receipt', 'ack', 'committed:true']);
});

test('consumer retries transient D1 failures and acks poison messages', async () => {
  const transient = queueMessage(minuteFactQueueMessage(input), 3);
  const poison = queueMessage({ message_type: 'unknown' });
  let calls = 0;
  const result = await consumeMinuteFactBatch({ messages: [transient, poison] }, {}, {
    enqueue: async () => {
      calls += 1;
      throw new Error('D1 unavailable');
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(result, { received: 2, enqueued: 0, duplicates: 0, retried: 1, invalid: 1 });
  assert.deepEqual(transient.calls, [['retry', { delaySeconds: 20 }]]);
  assert.deepEqual(poison.calls, [['ack']]);
});

test('minute worker exposes the Queue consumer handler through the health wrapper', () => {
  assert.equal(typeof minuteApp.queue, 'function');
});

test('delegated metadata enrichment uses MINUTE_DB and cannot fail the Queue job', async () => {
  const env = { BUDDIES_DB: {}, MINUTE_DB: {} };
  let receivedEnv = null;
  let receivedQueue = null;
  let receivedObservedAt = null;
  await runCommittedMetadataEnrichment(env, [{
    jobId: 'minute-fact:10:120000',
    payload: { queue: { tracks: [{ spotify_id: 'track-1' }] }, observedAt: 123_456 },
  }], {
    enrichTracks: async (sourceEnv, _ingest, queue, observedAt) => {
      receivedEnv = sourceEnv;
      receivedQueue = queue;
      receivedObservedAt = observedAt;
      return 1;
    },
  });
  assert.strictEqual(receivedEnv.DB, env.MINUTE_DB);
  assert.strictEqual(receivedEnv.MINUTE_DB, env.MINUTE_DB);
  assert.equal(receivedQueue.tracks[0].spotify_id, 'track-1');
  assert.equal(receivedObservedAt, 123_456);

  await assert.doesNotReject(runCommittedMetadataEnrichment(env, [{
    jobId: 'minute-fact:10:120000',
    payload: { queue: { tracks: [{ spotify_id: 'track-1' }] }, observedAt: 123_456 },
  }], { enrichTracks: async () => { throw new Error('Spotify unavailable'); } }));
});

test('producer rejects messages above the Queue safety limit', () => {
  assert.throws(() => minuteFactQueueMessage(input, {
    readModel: { channel: { presentation: { description: 'x'.repeat(MINUTE_FACT_QUEUE_MAX_MESSAGE_BYTES) } } },
  }), /message exceeds/);
});

test('producer stores queue tracks once and consumer restores the read model value', () => {
  const tracks = Array.from({ length: 70 }, (_, position) => ({
    position,
    spotify_id: `track-${position}`,
    title: `title-${position}-${'x'.repeat(400)}`,
    artist: `artist-${position}-${'y'.repeat(400)}`,
  }));
  const queue = { station_id: 5, queue_id: 9, tracks };
  const message = minuteFactQueueMessage({ ...input, queue }, {
    readModel: {
      channel: {
        channel_id: 10,
        observed_at: input.observedAt,
        presentation: { listener_count: 42, description: 'channel details' },
      },
      queue: { station_id: 5, queue_id: 9, value: queue },
      collector: { collector_id: 'cloudflare-worker' },
    },
  });

  assert.equal(Object.hasOwn(message.read_model.queue, 'value'), false);
  assert.equal(Object.hasOwn(message.read_model.channel.presentation, 'listener_count'), false);
  assert.equal(message.read_model.channel.presentation.description, 'channel details');
  assert.ok(new TextEncoder().encode(JSON.stringify(message)).byteLength < MINUTE_FACT_QUEUE_MAX_MESSAGE_BYTES);
  const parsed = parseMinuteFactQueueMessage(message);
  assert.strictEqual(parsed.read_model.queue.value, parsed.payload.queue);
  assert.equal(parsed.read_model.queue.value.tracks.length, 70);
  assert.equal(parsed.read_model.channel.presentation.listener_count, 42);
  assert.equal(parsed.read_model.channel.presentation.description, 'channel details');
});

test('producer can reuse collector presentation without rescanning snapshot fields', () => {
  const message = minuteFactQueueMessage(input, {
    readModelPresentationOnly: true,
    readModel: {
      channel: {
        presentation: { listener_count: 42, description: 'channel details' },
      },
    },
  });

  assert.equal(message.read_model.channel.presentation.listener_count, 42);
  assert.equal(message.read_model.channel.presentation.description, 'channel details');
});

test('consumer read model writes channel, queue, and collector state to MINUTE_DB', async () => {
  const batches = [];
  const MINUTE_DB = {
    prepare(sql) {
      return {
        sql,
        params: [],
        bind(...params) { this.params = params; return this; },
      };
    },
    async batch(statements) {
      batches.push(statements);
      return statements.map(() => ({ success: true }));
    },
  };
  await saveMinuteFactReadModels({ MINUTE_DB }, {
    channel: { channel_id: 10, observed_at: 123_456, presentation: { channel_name: 'Buddies' } },
    queue: { station_id: 5, queue_id: 9, start_time: 100, is_paused: false, value: { tracks: [] } },
    collector: {
      collector_id: 'buddies-worker',
      last_run_at: 123_456,
      last_success_at: 123_456,
      last_error_present: false,
      updated_at: 123_456,
    },
  }, 'minute-fact:10:120000');

  assert.equal(batches.length, 2);
  assert.equal(batches[1].length, 3);
  assert.match(batches[1][0].sql, /sh_channel_read_model/);
  assert.match(batches[1][1].sql, /sh_queue_read_model_current/);
  assert.match(batches[1][2].sql, /sh_collector_read_model/);
  assert.equal(batches[1][0].params[0], 10);
  assert.equal(batches[1][2].params[0], 'buddies-worker');
});

test('minute worker hydrates queue metadata from BUDDIES_DB instead of the primary collector', async () => {
  let metadataBindings = [];
  const BUDDIES_DB = {
    prepare(sql) {
      assert.match(sql, /FROM sh_track_metadata/);
      return {
        bind(...values) {
          metadataBindings = values;
          return this;
        },
        async all() {
          return { results: [{ spotify_id: 'track-1', title: 'Song', artist: 'Artist' }] };
        },
      };
    },
  };
  const batches = [];
  const MINUTE_DB = {
    prepare(sql) {
      return {
        sql,
        params: [],
        bind(...params) { this.params = params; return this; },
      };
    },
    async batch(statements) {
      batches.push(statements);
      return statements.map(() => ({ success: true }));
    },
  };

  await saveMinuteFactReadModels({ BUDDIES_DB, MINUTE_DB }, {
    channel: { channel_id: 10, observed_at: 123_456, presentation: {} },
    queue: {
      station_id: 5,
      queue_id: 9,
      start_time: 100,
      is_paused: false,
      value: { tracks: [{ spotify_id: 'track-1', title: null, artist: null }] },
    },
    collector: { collector_id: 'cloudflare-worker', updated_at: 123_456 },
  }, 'minute-fact:10:120000');

  assert.deepEqual(metadataBindings, ['track-1']);
  assert.match(batches[1][1].params[6], /"title":"Song"/);
  assert.match(batches[1][1].params[6], /"artist":"Artist"/);
});

test('minute worker hydrates comment facts before enqueueing minute facts', async () => {
  let enqueuedPayload = null;
  const BUDDIES_DB = {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          return sql.includes('sh_comment_minute_counts')
            ? { comment_count: 3 }
            : { total_count: 12 };
        },
      };
    },
  };
  const message = queueMessage(minuteFactQueueMessage({
    observedAt: 123_456,
    snapshot: { channel_id: 10, station_id: 5 },
    comments: { commentTotalKnown: false },
  }));

  await consumeMinuteFactBatch({ messages: [message] }, { BUDDIES_DB }, {
    hasReceipt: async () => false,
    enqueue: async (_env, payload) => {
      enqueuedPayload = payload;
      return { enqueued: true };
    },
    saveReadModels: async () => {},
    saveReceipt: async () => {},
  });

  assert.equal(enqueuedPayload.comments.commentCount, 3);
  assert.equal(enqueuedPayload.comments.commentTotal, 12);
  assert.equal(enqueuedPayload.comments.commentTotalKnown, true);
  assert.deepEqual(message.calls, [['ack']]);
});
