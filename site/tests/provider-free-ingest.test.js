import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const ingest = readFileSync(new URL('../functions/lib/ingest.js', import.meta.url), 'utf8');
const queueState = readFileSync(new URL('../functions/lib/queue-ingest-state.js', import.meta.url), 'utf8');
const optimized = readFileSync(new URL('../functions/lib/d1-optimized-ingest.js', import.meta.url), 'utf8');

test('active ingest modules contain no Apple compatibility fields or adapters', () => {
  for (const source of [ingest, queueState, optimized]) {
    assert.doesNotMatch(source, /apple_music_id|stripAppleMusicFields|appleMusicFree/i);
  }
});

test('ingest accepts only current direct handlers without a fallback writer', () => {
  assert.match(ingest, /const body = parsed\.body/);
  assert.match(ingest, /ingestOptimizedBody\(env, body\)/);
  assert.match(ingest, /unknown type/);
  assert.doesNotMatch(ingest, /fallbackContext|corePost|legacyPost|requestWithParsedJson/);
  assert.equal(existsSync(new URL('../functions/lib/ingest-core.js', import.meta.url)), false);
  assert.equal(existsSync(new URL('../functions/lib/ingest-legacy.mjs', import.meta.url)), false);
});
