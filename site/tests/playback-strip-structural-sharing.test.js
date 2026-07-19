import assert from 'node:assert/strict';
import test from 'node:test';

import {
  stripAppleMusicFields,
  stripPlaybackPublicFields,
} from '../functions/lib/api-utils.js';

test('clean playback objects and arrays retain identity', () => {
  const track = { title: 'Song', artist: 'Artist', spotify_id: 'spotify-track' };
  const queue = [track];
  const response = { queue, current: track };

  const stripped = stripAppleMusicFields(response);

  assert.equal(stripped, response);
  assert.equal(stripped.queue, queue);
  assert.equal(stripped.current, track);
});

test('only dirty branches are cloned', () => {
  const clean = { title: 'Clean', spotify_id: 'clean' };
  const dirty = { title: 'Dirty', apple_music_id: 'legacy', nested: clean };
  const source = { queue: [clean, dirty], status: { ok: true } };

  const stripped = stripAppleMusicFields(source);

  assert.notEqual(stripped, source);
  assert.notEqual(stripped.queue, source.queue);
  assert.equal(stripped.queue[0], clean);
  assert.notEqual(stripped.queue[1], dirty);
  assert.equal(stripped.queue[1].nested, clean);
  assert.equal('apple_music_id' in stripped.queue[1], false);
  assert.equal(stripped.status, source.status);
  assert.equal(dirty.apple_music_id, 'legacy');
});

test('public stripping keeps structural sharing while removing private identifiers', () => {
  const metadata = { title: 'Song', artist: 'Artist' };
  const source = {
    metadata,
    queue: [{ ...metadata, isrc: 'JPTEST000001', appleMusic: { id: 'legacy' } }],
  };
  const stripped = stripPlaybackPublicFields(source);
  assert.equal(stripped.metadata, metadata);
  assert.equal('isrc' in stripped.queue[0], false);
  assert.equal('appleMusic' in stripped.queue[0], false);
});
