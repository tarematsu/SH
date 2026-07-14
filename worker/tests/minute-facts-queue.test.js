import assert from 'node:assert/strict';
import test from 'node:test';

import minuteApp from '../src/minute-entry.js';
import { saveMinuteFactReadModels } from '../src/minute-facts-read-model.js';
import {
  consumeMinuteFactBatch,
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
            Object.assign(rows.get(jobId), { status: 'sent', sent_at: sentAt, last_attempt_at: lastAttemptAt, attempts: rows.get(jobId).attempts + 1 });
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
            const limit = this.params[0];
            return { results: [...rows.values()].filter((row) => row.status === 'pending').slice(0, limit) };
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

test('producer awaits durable Queue acceptance without touching FACTS_DB', async () => {
  let accepted = false;
  let sent;
  const env = {
    FACTS_DB: new Proxy({}, {
      get() { throw new Error('FACTS_DB must not be touched by producer'); },
    }),
    MINUTE_FACT_QUEUE: {
      async send(body, options) {
        await Promise.resolve();
        sent = { body, options };
        accepted = true;
      },
    },
  };

  const result = await sendMinuteFactJob(env, input);

  assert.equal(accepted, true);
  assert.equal(result.enqueued, true);
  assert.equal(result.channel_id, 10);
  assert.equal(result.minute_at, 120_000);
  assert.equal(sent.options.contentType, 'json');
  assert.deepEqual(parseMinuteFactQueueMessage(sent.body).payload, {
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

  const second = await handoffMinuteFactJob(env, input);
  assert.equal(second.enqueued, true);
  assert.equal(second.outbox_pending, false);
  assert.equal([...DB.rows.values()][0].status, 'sent');
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
  const result = await consumeMinuteFactBatch({ messages: [first, duplicate] }, { FACTS_DB: {} }, {
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

test('consumer read model writes channel, queue, and collector state to FACTS_DB', async () => {
  const batches = [];
  const FACTS_DB = {
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
  await saveMinuteFactReadModels({ FACTS_DB }, {
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
