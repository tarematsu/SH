import assert from 'node:assert/strict';
import test from 'node:test';

import { readModelNeedsHydration } from '../src/read-model-entry.js';

function completeTrack(index) {
  return {
    title: `Song ${index}`,
    artist: `Artist ${index}`,
    album_name: `Album ${index}`,
    thumbnail_url: `https://example.test/${index}.jpg`,
  };
}

test('read-model hydration scan preserves complete and incomplete queue decisions', () => {
  const complete = Array.from({ length: 40 }, (_, index) => completeTrack(index));
  assert.equal(readModelNeedsHydration({ queue: { value: { tracks: complete } } }), false);

  const incomplete = complete.slice();
  incomplete[31] = { ...incomplete[31], thumbnail_url: null };
  assert.equal(readModelNeedsHydration({ queue: { value: { tracks: incomplete } } }), true);
  assert.equal(readModelNeedsHydration({ queue: { value: { tracks: [] } } }), false);
  assert.equal(readModelNeedsHydration(null), false);
});
