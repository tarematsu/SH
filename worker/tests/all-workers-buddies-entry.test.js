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
  assert.equal(runtime.main, 'src/runtime-orchestrator-entry.js');
  assert.equal(runtime.queues.producers.find(({ binding }) => binding === 'RAW_COLLECTION_QUEUE').queue, 'stationhead-raw-collection');
  assert.match(entry, /const RAW_COLLECTION_QUEUE_OPTIONS = Object\.freeze/);
  assert.match(entry, /export default \{\s*scheduled\(_controller, env, ctx\)/s);
  assert.doesNotMatch(entry, /export default \{[^}]*\bfetch\s*:/s);
});

test('buddies ingest uses one-message switch dispatch and no HTTP handler', () => {
  const ingest = config('../wrangler.ingest.jsonc');
  const entry = source('../src/ingest-channel-optimized-entry.js');
  assert.equal(ingest.main, 'src/ingest-channel-optimized-entry.js');
  assert.equal(ingest.queues.consumers.every(({ max_batch_size }) => max_batch_size === 1), true);
  assert.match(entry, /const message = messages\[0\]/);
  assert.match(entry, /switch \(type\)/);
  assert.match(entry, /const EMPTY_DEPENDENCIES = Object\.freeze/);
  assert.doesNotMatch(entry, /fetch\s*\(/);
});

test('persist and comments are lazy Queue lanes of the ingest Worker', () => {
  const ingest = config('../wrangler.ingest.jsonc');
  const entry = source('../src/ingest-channel-optimized-entry.js');
  const consumers = new Map(ingest.queues.consumers.map((consumer) => [consumer.queue, consumer]));
  for (const queue of ['stationhead-comments', 'stationhead-buddies-persist']) {
    assert.equal(consumers.get(queue).max_batch_size, 1);
    assert.equal(consumers.get(queue).max_concurrency, 1);
  }
  assert.match(entry, /commentsModulePromise/);
  assert.match(entry, /persistModulePromise/);
  assert.match(entry, /CHAT_LIMIT: \{ value: 25/);
});
