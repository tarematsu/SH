import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('ingest uses compact completion logs and one retry-delay coercion', () => {
  const entry = source('../src/ingest-channel-optimized-entry.js');
  assert.match(entry, /function logIngestResult/);
  assert.doesNotMatch(entry, /console\.log\(JSON\.stringify\(result\)\)/);
  assert.match(entry, /let event = 'raw_collection_ingest_failed'/);
  assert.equal(entry.split('Number(error?.retryDelaySeconds)').length - 1, 1);
});

test('persistence reuses queue options and avoids validation arrays and sender closures', () => {
  const entry = source('../src/persist-channel-entry.js');
  assert.match(entry, /const EMPTY_DEPENDENCIES = Object\.freeze/);
  assert.match(entry, /const JSON_QUEUE_SEND_OPTIONS = Object\.freeze/);
  assert.doesNotMatch(entry, /\['snapshot', 'queue'\]\.includes/);
  assert.doesNotMatch(entry, /\[QUEUE_STAGE_PERSIST, QUEUE_STAGE_LIKES, QUEUE_STAGE_FINALIZE\]\.includes/);
  assert.match(entry, /const tracks = new Array\(sourceTracks\.length\)/);
  assert.match(entry, /async function sendPersistenceContinuation/);
  assert.match(entry, /env\.PERSIST_QUEUE\.send\(continuation, JSON_QUEUE_SEND_OPTIONS\)/);
  assert.equal(entry.split('JSON_QUEUE_SEND_OPTIONS').length - 1, 3);
});

test('deployed persistence wrapper logs stable compact fields', () => {
  const entry = source('../src/persist-channel-optimized-entry.js');
  assert.match(entry, /const RETRY_30_SECONDS = Object\.freeze/);
  assert.match(entry, /function logPersistenceResult/);
  assert.doesNotMatch(entry, /event: 'persistence_task_completed', \.\.\.result/);
});
