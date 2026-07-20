import assert from 'node:assert/strict';
import test from 'node:test';

import { readModelMetadataTask } from '../src/read-model-metadata-plan.js';

function model(tracks) {
  return { queue: { value: { tracks } } };
}

test('read-model metadata routing gives hydration precedence over preservation', () => {
  assert.equal(readModelMetadataTask(model([{
    spotify_id: 'album-gap',
    title: 'Song',
    artist: 'Artist',
    album_name: null,
    thumbnail_url: 'cover',
  }])), 'read-model-preserve');

  assert.equal(readModelMetadataTask(model([{
    spotify_id: 'album-gap',
    title: 'Song',
    artist: 'Artist',
    album_name: null,
    thumbnail_url: 'cover',
  }, {
    spotify_id: 'artist-gap',
    title: 'Song 2',
    artist: null,
    album_name: 'Album 2',
    thumbnail_url: 'cover-2',
  }])), 'read-model-hydration');

  assert.equal(readModelMetadataTask(model([{
    spotify_id: 'complete',
    title: 'Song',
    artist: 'Artist',
    album_name: 'Album',
    thumbnail_url: 'cover',
  }])), null);
});

test('unidentified metadata gaps bypass impossible hydration and preservation', () => {
  assert.equal(readModelMetadataTask(model([{
    spotify_id: null,
    isrc: null,
    title: null,
    artist: null,
    album_name: null,
    thumbnail_url: null,
  }])), null);
});

test('production routing scans complete tracks once', () => {
  let titleReads = 0;
  const tracks = Array.from({ length: 40 }, (_, index) => ({
    spotify_id: `spotify-${index}`,
    get title() { titleReads += 1; return `Song ${index}`; },
    artist: `Artist ${index}`,
    album_name: `Album ${index}`,
    thumbnail_url: `cover-${index}`,
  }));

  assert.equal(readModelMetadataTask(model(tracks)), null);
  assert.equal(titleReads, tracks.length);
});
