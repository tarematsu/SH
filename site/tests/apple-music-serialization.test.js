import assert from 'node:assert/strict';
import test from 'node:test';

import { rawJson, stripPlaybackFields } from '../functions/lib/api-utils.js';

test('rawJson drops nested Apple Music and preview fields without changing source objects', () => {
  const source = {
    station_id: 1,
    queue: [{
      spotify_id: 'spotify-track',
      apple_music_id: 'apple-track',
      appleMusic: { id: 'nested-apple' },
      preview_url: 'https://example.invalid/preview',
      nested: {
        Apple_Music_Id: 'mixed-case-apple',
        title: 'Song',
      },
    }],
  };

  const encoded = rawJson(source);
  const parsed = JSON.parse(encoded);

  assert.equal(parsed.queue[0].spotify_id, 'spotify-track');
  assert.equal(parsed.queue[0].nested.title, 'Song');
  assert.equal('apple_music_id' in parsed.queue[0], false);
  assert.equal('appleMusic' in parsed.queue[0], false);
  assert.equal('preview_url' in parsed.queue[0], false);
  assert.equal('Apple_Music_Id' in parsed.queue[0].nested, false);
  assert.equal(source.queue[0].apple_music_id, 'apple-track');
  assert.equal(source.queue[0].nested.Apple_Music_Id, 'mixed-case-apple');
});

test('rawJson matches the existing playback stripping contract', () => {
  const source = {
    apple: 'drop',
    spotify_id: 'keep',
    children: [{ preview: 'drop', title: 'keep' }],
  };
  assert.deepEqual(JSON.parse(rawJson(source)), stripPlaybackFields(source));
  assert.equal(rawJson(undefined), 'null');
});
