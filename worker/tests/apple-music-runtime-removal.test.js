import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const fastStore = readFileSync(new URL('../src/minute-facts-fast-store.js', import.meta.url), 'utf8');
const syncSource = readFileSync(new URL('../src/buddies-facts-sync.js', import.meta.url), 'utf8');

test('minute enrichment handoff does not copy Apple Music IDs', () => {
  const compactQueue = fastStore.slice(
    fastStore.indexOf('function compactPlaybackQueue'),
    fastStore.indexOf('async function enqueueMinuteEnrichment'),
  );
  assert.doesNotMatch(compactQueue, /apple[_-]?music/i);
  assert.match(compactQueue, /spotify_id/);
  assert.match(compactQueue, /isrc/);
});

test('buddies facts sync no longer writes Apple Music columns', () => {
  const likeStatement = syncSource.slice(
    syncSource.indexOf('function likeStatement'),
    syncSource.indexOf('function metadataStatement'),
  );
  assert.doesNotMatch(likeStatement, /apple[_-]?music/i);
  assert.match(likeStatement, /spotify_id,isrc/);
  assert.match(likeStatement, /SELECT \?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?/);
});
