import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function config(path) {
  return JSON.parse(source(path));
}

test('runtime orchestration retains the narrow raw collection surface', () => {
  const runtime = config('../wrangler.runtime.jsonc');
  const entry = source('../src/raw-collector-entry.js');
  assert.equal(runtime.main, 'src/runtime-orchestrator-deployed-entry.js');
  assert.equal(runtime.queues.producers.find(({ binding }) => binding === 'RAW_COLLECTION_QUEUE').queue, 'stationhead-raw-collection');
  assert.match(entry, /const RAW_COLLECTION_QUEUE_OPTIONS = Object\.freeze/);
  assert.match(entry, /export default \{\s*scheduled\(_controller, env, ctx\)/s);
  assert.doesNotMatch(entry, /export default \{[^}]*\bfetch\s*:/s);
});

test('core Worker uses one-message ingest switch dispatch and no ingest HTTP handler', () => {
  const runtime = config('../wrangler.runtime.jsonc');
  const entry = source('../src/ingest-channel-optimized-entry.js');
  const queues = [
    'stationhead-raw-collection',
    'stationhead-ingest-finalize',
    'stationhead-comments',
    'stationhead-buddies-persist',
  ];
  for (const queue of queues) {
    const consumer = runtime.queues.consumers.find((item) => item.queue === queue);
    assert.equal(consumer.max_batch_size, 1, queue);
  }
  assert.match(entry, /const message = messages\[0\]/);
  assert.match(entry, /switch \(type\)/);
  assert.match(entry, /const EMPTY_DEPENDENCIES = Object\.freeze/);
  assert.doesNotMatch(entry, /fetch\s*\(/);
});

test('persist and comments remain lazy Queue lanes of the core Worker', () => {
  const runtime = config('../wrangler.runtime.jsonc');
  const entry = source('../src/ingest-channel-optimized-entry.js');
  const consumers = new Map(runtime.queues.consumers.map((consumer) => [consumer.queue, consumer]));
  for (const queue of ['stationhead-comments', 'stationhead-buddies-persist']) {
    assert.equal(consumers.get(queue).max_batch_size, 1);
    assert.equal(consumers.get(queue).max_concurrency, 1);
  }
  assert.match(entry, /commentsModulePromise/);
  assert.match(entry, /persistModulePromise/);
  assert.match(entry, /CHAT_LIMIT: \{ value: 25/);
});
