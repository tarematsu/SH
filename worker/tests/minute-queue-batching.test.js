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

test('derive processes and acknowledges every message in a two-message delivery', async () => {
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

test('paired revision materialization caps each message at one track', async () => {
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

test('production batches live derive and rebuild while recovery derive stays isolated', () => {
  const derive = config('wrangler.minute-derive.jsonc');
  const rebuild = config('wrangler.minute-rebuild.jsonc');
  const entry = readFileSync(new URL('../src/minute-derive-entry.js', import.meta.url), 'utf8');
  assert.deepEqual(derive.queues.consumers.map(({ max_batch_size }) => max_batch_size), [1, 2]);
  assert.equal(derive.vars.DERIVE_REVISION_CHUNK_TRACKS, 2);
  assert.equal(rebuild.queues.consumers[0].max_batch_size, 2);
  assert.equal(rebuild.queues.consumers[0].max_concurrency, 1);
  assert.match(entry, /const LIVE_REVISION_CHUNK_TRACKS = 1/);
  assert.match(entry, /minute_derive_queue_overloaded/);
});

test('batched derive composes with the merged CPU, KV, and Worker topology contracts', () => {
  const budget = readFileSync(
    new URL('../../.github/scripts/enforce-worker-cpu-budget.py', import.meta.url),
    'utf8',
  );
  const pagesKv = readFileSync(
    new URL('../scripts/pages-response-kv-namespace.mjs', import.meta.url),
    'utf8',
  );
  const enrichment = config('wrangler.minute-enrichment.jsonc');
  assert.match(budget, /BUDGET_MS = 9\.0/);
  assert.match(budget, /"comparison": "less_than_or_equal"/);
  assert.match(pagesKv, /NAMESPACE_PAGE_SIZE = 1000/);
  assert.deepEqual(
    enrichment.queues.consumers.map(({ queue }) => queue).sort(),
    ['stationhead-minute-enrichment', 'stationhead-track-metadata'],
  );
  assert.equal(existsSync(new URL('../wrangler.track-metadata.jsonc', import.meta.url)), false);
});
