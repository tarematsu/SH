import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('derive router caches store modules and routes stages once', () => {
  const router = source('../src/minute-derive-router.js');
  assert.match(router, /const EMPTY_DEPENDENCIES = Object\.freeze/);
  assert.match(router, /sparseRebuildStorePromise \|\|=/);
  assert.match(router, /rebuildStorePromise \|\|=/);
  assert.match(router, /fastStorePromise \|\|=/);
  assert.match(router, /const stage = body\.stage/);
  assert.match(router, /if \(stage === 'write'\)/);
  assert.doesNotMatch(router, /function isStage\(/);
  assert.match(router, /queue\.send\(message, JSON_QUEUE_SEND_OPTIONS\)/);
});

test('derive entry emits compact success logs and reuses retry options', () => {
  const entry = source('../src/minute-derive-entry.js');
  assert.match(entry, /const RETRY_60_SECONDS = Object\.freeze/);
  assert.match(entry, /function logMinuteDeriveResult/);
  assert.doesNotMatch(entry, /console\.log\(JSON\.stringify\(result\)\)/);
  assert.match(entry, /message\.retry\(RETRY_60_SECONDS\)/);
});
