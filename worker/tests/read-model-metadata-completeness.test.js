import assert from 'node:assert/strict';
import test from 'node:test';

import { queueNeedsPreviousTrackMetadata } from '../src/minute-facts-read-model.js';

test('previous queue metadata lookup is required only for incomplete non-empty queues', () => {
  assert.equal(queueNeedsPreviousTrackMetadata(null), false);
  assert.equal(queueNeedsPreviousTrackMetadata({ tracks: [] }), false);
  assert.equal(queueNeedsPreviousTrackMetadata({
    tracks: [{ title: '', artist: 'Artist', album_name: 'Album', thumbnail_url: 'cover' }],
  }), true);
  assert.equal(queueNeedsPreviousTrackMetadata({
    tracks: [{ title: 'Song', artist: 'Artist', album_name: 'Album', thumbnail_url: 'cover' }],
  }), false);
});
