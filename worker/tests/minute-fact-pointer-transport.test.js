import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  consumeMinuteFactBatch,
  flushMinuteFactOutbox,
  handoffMinuteFactJob,
  MINUTE_FACT_POINTER_MESSAGE_TYPE,
  minuteFactQueueSourceMessage,
} from '../src/minute-facts-queue.js';

function queueMessage(body, attempts = 1) {
  const calls = [];
  return {
    id: `pointer-${attempts}`,
    attempts,
    body,
    calls,
    ack() { calls.push(['ack']); },
    retry(options) { calls.push(['retry', options]); },
  };
}

function pointerDb() {
  const rows = new Map();
  const db = {
    rows,
    failSentTransitionOnce: false,
    prepare(sql) {
      const statement = {
        params: [],
        bind(...params) { this.params = params; return this; },
        async run() {
          if (sql.includes('INSERT OR IGNORE INTO sh_minute_fact_outbox')) {
            const [jobId, payloadJson, createdAt] = this.params;
            if (rows.has(jobId)) return { meta: { changes: 0 } };
            rows.set(jobId, {
              job_id: jobId,
              payload_json: payloadJson,
              status: 'pending',
              attempts: 0,
              created_at: createdAt,
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('SET payload_json=?') && sql.includes("status='pending'")) {
            const [payloadJson, jobId] = this.params;
            const row = rows.get(jobId);
            if (!row || row.status !== 'pending') return { meta: { changes: 0 } };
            row.payload_json = payloadJson;
            return { meta: { changes: 1 } };
          }
          if (sql.includes('payload_json=?,last_attempt_at=?')) {
            const [payloadJson, lastAttemptAt, jobId] = this.params;
            const row = rows.get(jobId);
            if (!row || row.status !== 'sent') return { meta: { changes: 0 } };
            Object.assign(row, { payload_json: payloadJson, last_attempt_at: lastAttemptAt, last_error: null });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('sent_at=COALESCE(sent_at,?)') && sql.includes("status='pending'")) {
            const [payloadJson, sentAt, lastAttemptAt, jobId] = this.params;
            const row = rows.get(jobId);
            if (!row || row.status !== 'pending') return { meta: { changes: 0 } };
            Object.assign(row, {
              status: 'sent',
              payload_json: payloadJson,
              sent_at: row.sent_at ?? sentAt,
              last_attempt_at: lastAttemptAt,
              last_error: null,
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("status='sent'") && !sql.includes("payload_json='{}'")) {
            if (db.failSentTransitionOnce) {
              db.failSentTransitionOnce = false;
              throw new Error('producer ledger update failed');
            }
            const [sentAt, lastAttemptAt, jobId] = this.params;
            const row = rows.get(jobId);
            if (!row || row.status !== 'pending') return { meta: { changes: 0 } };
            Object.assign(row, {
              status: 'sent',
              sent_at: sentAt,
              last_attempt_at: lastAttemptAt,
              attempts: row.attempts + 1,
              last_error: null,
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('attempts=attempts+1,last_attempt_at')) {
            const [lastAttemptAt, lastError, jobId] = this.params;
            const row = rows.get(jobId);
            Object.assign(row, {
              attempts: row.attempts + 1,
              last_attempt_at: lastAttemptAt,
              last_error: lastError,
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('DELETE FROM sh_minute_fact_outbox')) return { meta: { changes: 0 } };
          throw new Error(`unexpected run: ${sql}`);
        },
        async all() {
          if (sql.includes("FROM sh_minute_fact_outbox WHERE status='pending'")) {
            const [currentJobId, limit] = this.params;
            return {
              results: [...rows.values()]
                .filter((row) => row.status === 'pending')
                .slice(0, limit)
                .map((row) => ({
                  job_id: row.job_id,
                  payload_json: row.job_id === currentJobId ? null : row.payload_json,
                  attempts: row.attempts,
                })),
            };
          }
          throw new Error(`unexpected all: ${sql}`);
        },
        async first() {
          if (sql.includes('SELECT status,payload_json')) return rows.get(this.params[0]) || null;
          if (sql.includes('SELECT status FROM')) return rows.get(this.params[0]) || null;
          if (sql.includes('COUNT(*)')) {
            return { count: [...rows.values()].filter((row) => row.status === 'pending').length };
          }
          throw new Error(`unexpected first: ${sql}`);
        },
      };
      return statement;
    },
  };
  return db;
}

function r2Bucket() {
  const objects = new Map();
  return {
    objects,
    failDelete: false,
    async put(key, value, options) { objects.set(key, { value: String(value), options }); },
    async get(key) {
      const stored = objects.get(key);
      return stored ? { async text() { return stored.value; } } : null;
    },
    async delete(key) {
      if (this.failDelete) throw new Error('temporary R2 delete failure');
      objects.delete(key);
    },
  };
}

const input = {
  observedAt: 180_001,
  snapshot: { channel_id: 10, listener_count: 20 },
  queue: { queue_id: 7, tracks: [] },
  comments: {},
};

test('outbox sends a sub-64KB pointer while retaining the full payload in R2', async () => {
  const DB = pointerDb();
  const R2 = r2Bucket();
  let sent = null;
  const env = {
    DB,
    MINUTE_FACT_POINTER_QUEUE_ENABLED: true,
    PAGES_RESPONSE_R2: R2,
    MINUTE_FACT_QUEUE: { async send(value) { sent = value; } },
  };
  const largeDescription = 'x'.repeat(70 * 1024);

  const result = await handoffMinuteFactJob(env, input, {
    readModel: { channel: { presentation: { description: largeDescription } } },
  });

  assert.equal(result.enqueued, true);
  assert.equal(sent.message_type, MINUTE_FACT_POINTER_MESSAGE_TYPE);
  assert.ok(new TextEncoder().encode(JSON.stringify(sent)).byteLength < 64 * 1024);
  const stored = R2.objects.get(sent.storage_key);
  assert.ok(new TextEncoder().encode(stored.value).byteLength > 64 * 1024);
  assert.equal(stored.options.httpMetadata.contentType, 'application/json');
  assert.equal(DB.rows.get(sent.job_id).status, 'sent');
  assert.equal(JSON.parse(DB.rows.get(sent.job_id).payload_json).storage_key, sent.storage_key);
  assert.equal(minuteFactQueueSourceMessage(sent).read_model.channel.presentation.description, largeDescription);
});

test('consumer resolves, completes, deletes, and deduplicates a pointer payload', async () => {
  const DB = pointerDb();
  const R2 = r2Bucket();
  let pointer = null;
  const env = {
    DB,
    BUDDIES_DB: DB,
    MINUTE_FACT_POINTER_QUEUE_ENABLED: true,
    PAGES_RESPONSE_R2: R2,
    MINUTE_FACT_QUEUE: { async send(value) { pointer = value; } },
  };
  await handoffMinuteFactJob(env, input, {
    readModel: { channel: { presentation: { description: 'pointer read model' } } },
  });

  const first = queueMessage(pointer);
  const writes = [];
  const readModels = [];
  const firstResult = await consumeMinuteFactBatch({ messages: [first] }, env, {
    enqueue: async (_activeEnv, payload) => { writes.push(payload); return { enqueued: true }; },
    saveReadModels: async (_activeEnv, readModel) => readModels.push(readModel),
  });

  assert.deepEqual(firstResult, { received: 1, enqueued: 1, duplicates: 0, retried: 0, invalid: 0 });
  assert.deepEqual(first.calls, [['ack']]);
  assert.equal(writes.length, 1);
  assert.equal(readModels[0].channel.presentation.description, 'pointer read model');
  assert.equal(R2.objects.has(pointer.storage_key), false);
  const marker = JSON.parse(DB.rows.get(pointer.job_id).payload_json);
  assert.equal(marker.consumed, true);
  assert.equal(marker.storage_key, pointer.storage_key);

  const duplicate = queueMessage(pointer, 2);
  const duplicateResult = await consumeMinuteFactBatch({ messages: [duplicate] }, env, {
    enqueue: async () => { throw new Error('duplicate must not be processed'); },
  });
  assert.deepEqual(duplicateResult, { received: 1, enqueued: 0, duplicates: 1, retried: 0, invalid: 0 });
  assert.deepEqual(duplicate.calls, [['ack']]);
});

test('persisted pointer retries rehydrate the source message before producer wrappers run', async () => {
  const DB = pointerDb();
  const R2 = r2Bucket();
  const env = {
    DB,
    MINUTE_FACT_POINTER_QUEUE_ENABLED: true,
    PAGES_RESPONSE_R2: R2,
    MINUTE_FACT_QUEUE: { async send() { throw new Error('temporary Queue outage'); } },
  };
  const first = await handoffMinuteFactJob(env, input, {
    readModel: { channel: { presentation: { description: 'retry source' } } },
  });
  assert.equal(first.enqueued, false);
  const row = [...DB.rows.values()][0];
  assert.equal(row.status, 'pending');
  assert.equal(JSON.parse(row.payload_json).message_type, MINUTE_FACT_POINTER_MESSAGE_TYPE);

  let source = null;
  env.MINUTE_FACT_QUEUE = {
    async send(pointer) {
      source = minuteFactQueueSourceMessage(pointer);
    },
  };
  const result = await flushMinuteFactOutbox(env, { limit: 1 });

  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  assert.equal(source.message_type, 'minute-fact-job');
  assert.equal(source.read_model.channel.presentation.description, 'retry source');
  assert.equal(row.status, 'sent');
});

test('corrupt R2 pointer payloads retry instead of being acknowledged as invalid Queue messages', async () => {
  const DB = pointerDb();
  const R2 = r2Bucket();
  let pointer = null;
  const env = {
    DB,
    BUDDIES_DB: DB,
    MINUTE_FACT_POINTER_QUEUE_ENABLED: true,
    PAGES_RESPONSE_R2: R2,
    MINUTE_FACT_QUEUE: { async send(value) { pointer = value; } },
  };
  await handoffMinuteFactJob(env, input);
  R2.objects.get(pointer.storage_key).value = '{broken';

  const message = queueMessage(pointer);
  const result = await consumeMinuteFactBatch({ messages: [message] }, env, {
    enqueue: async () => { throw new Error('corrupt payload must not be processed'); },
  });

  assert.deepEqual(result, { received: 1, enqueued: 0, duplicates: 0, retried: 1, invalid: 0 });
  assert.deepEqual(message.calls, [['retry', { delaySeconds: 5 }]]);
});

test('consumed marker deduplicates a pointer even when R2 deletion failed', async () => {
  const DB = pointerDb();
  const R2 = r2Bucket();
  let pointer = null;
  const env = {
    DB,
    BUDDIES_DB: DB,
    MINUTE_FACT_POINTER_QUEUE_ENABLED: true,
    PAGES_RESPONSE_R2: R2,
    MINUTE_FACT_QUEUE: { async send(value) { pointer = value; } },
  };
  await handoffMinuteFactJob(env, input);
  R2.failDelete = true;

  const first = queueMessage(pointer);
  await consumeMinuteFactBatch({ messages: [first] }, env, {
    enqueue: async () => ({ enqueued: true }),
  });
  assert.deepEqual(first.calls, [['ack']]);
  assert.equal(R2.objects.has(pointer.storage_key), true);

  const duplicate = queueMessage(pointer, 2);
  const result = await consumeMinuteFactBatch({ messages: [duplicate] }, env, {
    enqueue: async () => { throw new Error('consumed pointer must not be processed again'); },
  });
  assert.deepEqual(result, { received: 1, enqueued: 0, duplicates: 1, retried: 0, invalid: 0 });
  assert.deepEqual(duplicate.calls, [['ack']]);
});

test('consumer closes a pending ledger row after Queue delivery outruns the producer status update', async () => {
  const DB = pointerDb();
  const R2 = r2Bucket();
  let pointer = null;
  DB.failSentTransitionOnce = true;
  const env = {
    DB,
    BUDDIES_DB: DB,
    MINUTE_FACT_POINTER_QUEUE_ENABLED: true,
    PAGES_RESPONSE_R2: R2,
    MINUTE_FACT_QUEUE: { async send(value) { pointer = value; } },
  };
  const handoff = await handoffMinuteFactJob(env, input);
  const row = DB.rows.get(pointer.job_id);
  assert.equal(handoff.enqueued, false);
  assert.equal(row.status, 'pending');

  const delivered = queueMessage(pointer);
  const result = await consumeMinuteFactBatch({ messages: [delivered] }, env, {
    enqueue: async () => ({ enqueued: true }),
  });

  assert.deepEqual(result, { received: 1, enqueued: 1, duplicates: 0, retried: 0, invalid: 0 });
  assert.deepEqual(delivered.calls, [['ack']]);
  assert.equal(row.status, 'sent');
  assert.equal(JSON.parse(row.payload_json).consumed, true);
  assert.equal(R2.objects.has(pointer.storage_key), false);
});

test('collector and runtime disable pointer staging for normal minute facts', () => {
  const collector = JSON.parse(readFileSync(
    new URL('../wrangler.buddies-collector.jsonc', import.meta.url),
    'utf8',
  ));
  const runtime = JSON.parse(readFileSync(
    new URL('../wrangler.runtime.jsonc', import.meta.url),
    'utf8',
  ));
  assert.equal(collector.vars.MINUTE_FACT_POINTER_QUEUE_ENABLED, false);
  assert.equal(runtime.vars.MINUTE_FACT_POINTER_QUEUE_ENABLED, false);
  assert.equal(collector.r2_buckets.some(({ binding }) => binding === 'PAGES_RESPONSE_R2'), true);
  assert.equal(runtime.r2_buckets.some(({ binding }) => binding === 'PAGES_RESPONSE_R2'), true);
});
