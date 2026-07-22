import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  LIVE_DERIVE_QUEUE_NAME,
  processMinuteDeriveBatch,
} from '../src/minute-derive-entry.js';

function config(name) {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

function queueMessage(id, events, body = { id }) {
  return {
    body,
    ack() { events.push(`ack:${id}`); },
    retry() { events.push(`retry:${id}`); },
  };
}

test('derive helper preserves acknowledgement for a defensive multi-message delivery', async () => {
  const events = [];
  const processed = [];
  const messages = [queueMessage(1, events), queueMessage(2, events)];
  await processMinuteDeriveBatch({ queue: LIVE_DERIVE_QUEUE_NAME, messages }, {
    MINUTE_LIVE_DERIVE_QUEUE: { send() {} },
    MINUTE_DERIVE_QUEUE: { send() {} },
  }, {
    async processMessage(_env, body) {
      processed.push(body.id);
      return { processed: 1, failed: 0, job_id: body.id };
    },
  });
  assert.deepEqual(processed, [1, 2]);
  assert.deepEqual(events, ['ack:1', 'ack:2']);
});

test('defensive paired revision handling caps each message at one track', async () => {
  const events = [];
  const chunkTracks = [];
  const revisionBody = (id) => ({
    id,
    message_type: 'minute-fact-derive-stage',
    message_version: 1,
    stage: 'revision-materialize',
    revision: { revision_id: id },
  });
  const messages = [
    queueMessage(1, events, revisionBody(1)),
    queueMessage(2, events, revisionBody(2)),
  ];
  await processMinuteDeriveBatch({ queue: LIVE_DERIVE_QUEUE_NAME, messages }, {
    DERIVE_REVISION_CHUNK_TRACKS: 2,
    MINUTE_LIVE_DERIVE_QUEUE: { send() {} },
    MINUTE_DERIVE_QUEUE: { send() {} },
  }, {
    async processMessage(activeEnv, body) {
      chunkTracks.push(activeEnv.DERIVE_REVISION_CHUNK_TRACKS);
      return { processed: 1, failed: 0, job_id: body.id };
    },
  });
  assert.deepEqual(chunkTracks, [1, 1]);
  assert.deepEqual(events, ['ack:1', 'ack:2']);
});

test('runtime isolates all CPU-sensitive derive and rebuild deliveries', () => {
  const runtime = config('wrangler.runtime.jsonc');
  const entry = readFileSync(new URL('../src/minute-derive-entry.js', import.meta.url), 'utf8');
  const consumers = new Map(runtime.queues.consumers.map((consumer) => [consumer.queue, consumer]));
  assert.deepEqual([
    consumers.get('stationhead-minute-derive').max_batch_size,
    consumers.get('stationhead-minute-live-derive').max_batch_size,
    consumers.get('stationhead-buddies-facts').max_batch_size,
    consumers.get('stationhead-minute-rebuild').max_batch_size,
  ], [1, 1, 1, 1]);
  assert.equal(runtime.vars.DERIVE_REVISION_CHUNK_TRACKS, 1);
  assert.equal(consumers.get('stationhead-minute-live-derive').max_concurrency, 2);
  assert.equal(consumers.get('stationhead-minute-rebuild').max_concurrency, 1);
  assert.match(entry, /const MAX_LIVE_REVISION_CHUNK_TRACKS = 1/);
  assert.match(entry, /env\?\.DERIVE_REVISION_CHUNK_TRACKS/);
  assert.match(entry, /minute_derive_queue_overloaded/);
});

test('derive isolation composes with the merged CPU, KV, and Worker topology contracts', () => {
  const budget = readFileSync(
    new URL('../../.github/scripts/enforce-worker-cpu-budget.py', import.meta.url),
    'utf8',
  );
  const pagesKv = readFileSync(
    new URL('../scripts/pages-response-kv-namespace.mjs', import.meta.url),
    'utf8',
  );
  const runtime = config('wrangler.runtime.jsonc');
  assert.match(budget, /BUDGET_MS = 10\.0/);
  assert.match(budget, /"comparison": "less_than_or_equal"/);
  assert.match(pagesKv, /NAMESPACE_PAGE_SIZE = 1000/);
  const consumers = new Set(runtime.queues.consumers.map(({ queue }) => queue));
  for (const queue of [
    'stationhead-minute-enrichment',
    'stationhead-pages-read-model-publication',
    'stationhead-read-model',
    'stationhead-track-metadata',
  ]) {
    assert.equal(consumers.has(queue), true, queue);
  }
  assert.equal(existsSync(new URL('../wrangler.track-metadata.jsonc', import.meta.url)), false);
  assert.equal(existsSync(new URL('../wrangler.minute-enrichment.jsonc', import.meta.url)), false);
});
