import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const activeSources = [
  '../src/minute-revision-materializer.js',
  '../src/minute-enrichment-optimized-entry.js',
  '../src/minute-enrichment-playback-stages.js',
  '../src/minute-enrichment-identity-stages.js',
  '../src/persist-likes-stages.js',
  '../src/persist-structure-stages.js',
].map((path) => ({
  path,
  source: readFileSync(new URL(path, import.meta.url), 'utf8'),
}));

test('active Worker persistence and enrichment paths contain no Apple compatibility identity', () => {
  for (const { path, source } of activeSources) {
    assert.doesNotMatch(source, /apple_music_id|appleMusic|Apple Music/i, path);
  }
});

test('retired compatibility and legacy entrypoints are physically absent', () => {
  for (const path of [
    '../../site/functions/lib/apple-music-d1-pruner.js',
    '../../site/functions/lib/apple-music-track-history-sql.js',
    '../../site/functions/lib/ingest-core.js',
    '../../site/functions/lib/ingest-legacy.mjs',
    '../../site/functions/lib/host-ingest-core.js',
    '../../site/functions/lib/host-ingest-legacy.mjs',
    '../src/minute-enrichment-entry.js',
    '../src/buddy-playback-entry.js',
  ]) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, path);
  }
});
