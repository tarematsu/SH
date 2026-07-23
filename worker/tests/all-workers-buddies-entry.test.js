import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function config(path) {
  return JSON.parse(source(path));
}

const INGEST_QUEUES = Object.freeze([
  'stationhead-raw-collection',
  'stationhead-ingest-finalize',
  'stationhead-comments',
  'stationhead-buddies-persist',
]);

test('dedicated buddies Worker owns the narrow raw collection surface', () => {
  const collector = config('../wrangler.buddies-collector.jsonc');
  const runtime = config('../wrangler.runtime.jsonc');
  const entry = source('../src/buddies-collector-entry.js');
  assert.equal(collector.main, 'src/buddies-collector-entry.js');
  assert.equal(
    collector.queues.producers.find(({ binding }) => binding === 'RAW_COLLECTION_QUEUE').queue,
    'stationhead-raw-collection',
  );
  assert.equal(runtime.queues.producers.some(({ binding }) => binding === 'RAW_COLLECTION_QUEUE'), false);
  assert.equal(runtime.vars.RAW_COLLECTION_ENABLED, false);
  assert.match(entry, /runBuddiesCollectorScheduled/);
  assert.doesNotMatch(entry, /\bfetch\s*:/);
});

test('dedicated buddies Worker uses one-message ingest switch dispatch', () => {
  const collector = config('../wrangler.buddies-collector.jsonc');
  const runtime = config('../wrangler.runtime.jsonc');
  const entry = source('../src/ingest-channel-optimized-entry.js');
  const collectorConsumers = new Map(
    collector.queues.consumers.map((consumer) => [consumer.queue, consumer]),
  );
  const runtimeConsumers = new Set(runtime.queues.consumers.map(({ queue }) => queue));
  for (const queue of INGEST_QUEUES) {
    assert.equal(collectorConsumers.get(queue).max_batch_size, 1, queue);
    assert.equal(runtimeConsumers.has(queue), false, queue);
  }
  assert.match(entry, /const message = messages\[0\]/);
  assert.match(entry, /switch \(type\)/);
  assert.match(entry, /const EMPTY_DEPENDENCIES = Object\.freeze/);
  assert.doesNotMatch(entry, /fetch\s*\(/);
});

test('persist and comments remain lazy bounded lanes of the dedicated Worker', () => {
  const collector = config('../wrangler.buddies-collector.jsonc');
  const entry = source('../src/ingest-channel-optimized-entry.js');
  const consumers = new Map(collector.queues.consumers.map((consumer) => [consumer.queue, consumer]));
  for (const queue of ['stationhead-comments', 'stationhead-buddies-persist']) {
    assert.equal(consumers.get(queue).max_batch_size, 1);
    assert.equal(consumers.get(queue).max_concurrency, 1);
  }
  assert.match(entry, /commentsModulePromise/);
  assert.match(entry, /persistModulePromise/);
  assert.match(entry, /CHAT_LIMIT: \{ value: 25/);
});
