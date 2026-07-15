import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { loadMinuteFactQueueMetadata } from '../src/collector-runner.js';

test('primary collector owns optional comments while metadata stays delegated', () => {
  const source = readFileSync(new URL('../src/collector-runner.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /sharedEnrichTracks|d1_write_track_metadata/);
  assert.match(source, /collectOptionalComments/);
  assert.match(source, /stage = 'sh_chat_history'/);
  assert.match(source, /enrichTrackMetadata: metadataPlanned/);
  assert.match(source, /collectComments: false/);
  assert.match(source, /comments_deferred: false/);
});

test('loadMinuteFactQueueMetadata reads distinct ids and hydrates the Queue read model', async () => {
  let bindings = [];
  const db = {
    prepare(sql) {
      assert.match(sql, /FROM sh_track_metadata/);
      return {
        bind(...values) {
          bindings = values;
          return this;
        },
        async all() {
          return { results: [{ spotify_id: 'track-1', title: 'Song', artist: 'Artist' }] };
        },
      };
    },
  };
  const queue = {
    tracks: [
      { spotify_id: 'track-1', title: null, artist: null },
      { spotify_id: 'track-1', title: null, artist: null },
    ],
  };

  const result = await loadMinuteFactQueueMetadata(db, queue);
  assert.deepEqual(bindings, ['track-1']);
  assert.equal(result.tracks[0].title, 'Song');
  assert.equal(result.tracks[1].artist, 'Artist');
});

test('loadMinuteFactQueueMetadata skips tracks whose presentation metadata is complete', async () => {
  let prepared = false;
  const db = {
    prepare() {
      prepared = true;
      return { bind() { return this; }, async all() { return { results: [] }; } };
    },
  };
  const queue = {
    tracks: [{
      spotify_id: 'track-1',
      title: 'Song',
      artist: 'Artist',
      thumbnail_url: 'https://example.test/cover.jpg',
    }],
  };

  const result = await loadMinuteFactQueueMetadata(db, queue);

  assert.equal(prepared, false);
  assert.strictEqual(result, queue);
});

test('loadMinuteFactQueueMetadata reuses metadata already fetched in the same collection', async () => {
  let prepared = false;
  const db = {
    prepare() {
      prepared = true;
      throw new Error('metadata should not be reread');
    },
  };
  const queue = {
    tracks: [{ spotify_id: 'track-1', title: null, artist: null, thumbnail_url: null }],
  };

  const result = await loadMinuteFactQueueMetadata(db, queue, [{
    spotify_id: 'track-1',
    title: 'Song',
    artist: 'Artist',
    thumbnail_url: 'https://example.test/cover.jpg',
  }]);

  assert.equal(prepared, false);
  assert.equal(result.tracks[0].title, 'Song');
  assert.equal(result.tracks[0].artist, 'Artist');
  assert.equal(result.tracks[0].thumbnail_url, 'https://example.test/cover.jpg');
});
