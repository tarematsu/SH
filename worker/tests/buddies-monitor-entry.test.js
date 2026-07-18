import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import buddiesMonitor from '../src/raw-collector-entry.js';

test('buddies monitor keeps its existing deployment entry', () => {
  const config = JSON.parse(readFileSync(
    new URL('../wrangler.jsonc', import.meta.url),
    'utf8',
  ));

  assert.equal(config.name, 'sh-buddies-monitor');
  assert.equal(config.main, 'src/raw-collector-entry.js');
});

test('scheduled-only production surface registers the collection promise directly', async () => {
  const waited = [];
  const result = buddiesMonitor.scheduled(null, {}, {
    waitUntil(promise) {
      waited.push(promise);
    },
  });

  assert.equal(result, undefined);
  assert.deepEqual(Object.keys(buddiesMonitor), ['scheduled']);
  assert.equal(waited.length, 1);
  await assert.rejects(waited[0], /RAW_COLLECTION_QUEUE binding is missing/);
});
