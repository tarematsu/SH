import assert from 'node:assert/strict';
import test from 'node:test';

import { loadMinuteFactQueueMetadata } from '../src/collector-runner.js';

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
