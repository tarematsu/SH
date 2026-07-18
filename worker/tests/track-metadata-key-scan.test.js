import assert from 'node:assert/strict';
import test from 'node:test';

import { hydrateReadModelMetadata } from '../src/read-model-stages.js';

function readModel(tracks) {
  return { queue: { value: { tracks } } };
}

function metadataEnv(calls) {
  return {
    MINUTE_DB: {
      prepare(sql) {
        return {
          bind(...bindings) {
            calls.push({ sql, bindings });
            return { all: async () => ({ results: [] }) };
          },
        };
      },
    },
  };
}

test('metadata hydration scans incomplete tracks once and preserves key order', async () => {
  const calls = [];
  const model = readModel([
    { title: 'complete', artist: 'artist', thumbnail_url: 'image', spotify_id: 'ignored', isrc: 'ignored' },
    { spotify_id: ' spotify-a ', isrc: ' us-a ' },
    { spotify_id: 'spotify-a', isrc: 'US-A' },
    { title: 'partial', spotify_id: 'spotify-b', isrc: 'gb-b' },
    null,
  ]);

  assert.equal(await hydrateReadModelMetadata(metadataEnv(calls), model), model);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].bindings, ['US-A', 'GB-B', 'spotify-a', 'spotify-b']);
});

test('metadata hydration keeps collecting the second key type after the first reaches its cap', async () => {
  const calls = [];
  const tracks = [];
  for (let index = 0; index < 90; index += 1) tracks.push({ spotify_id: `spotify-${index}` });
  for (let index = 0; index < 90; index += 1) tracks.push({ isrc: `isrc-${index}` });

  await hydrateReadModelMetadata(metadataEnv(calls), readModel(tracks));

  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0].bindings,
    [
      ...Array.from({ length: 80 }, (_, index) => `ISRC-${index}`),
      ...Array.from({ length: 80 }, (_, index) => `spotify-${index}`),
    ],
  );
});

test('metadata hydration does not spend key capacity on duplicates', async () => {
  const calls = [];
  const tracks = Array.from({ length: 20 }, () => ({
    spotify_id: ' duplicate ',
    isrc: ' duplicate ',
  }));
  for (let index = 0; index < 85; index += 1) {
    tracks.push({ spotify_id: `spotify-${index}`, isrc: `isrc-${index}` });
  }

  await hydrateReadModelMetadata(metadataEnv(calls), readModel(tracks));

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].bindings, [
    'DUPLICATE',
    ...Array.from({ length: 79 }, (_, index) => `ISRC-${index}`),
    'duplicate',
    ...Array.from({ length: 79 }, (_, index) => `spotify-${index}`),
  ]);
});
