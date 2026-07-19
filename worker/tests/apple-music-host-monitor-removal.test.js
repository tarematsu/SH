import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  normalizeProfile,
  normalizeQueue,
} from '../src/cloud-host-monitor-normalize.js';

test('host queue normalization removes explicit and nested Apple Music data', () => {
  const station = {
    id: 1,
    queue: {
      id: 2,
      start_time: 100,
      apple_music_id: 'queue-legacy',
      tracks: [{
        id: 3,
        apple_music_id: 'item-legacy',
        track: {
          id: 4,
          spotify_id: 'spotify-track',
          apple_music_id: 'track-legacy',
          isrc: 'JPTEST000001',
          duration: 120000,
        },
      }],
    },
  };
  const queue = normalizeQueue(station, 110);
  assert.equal(queue.tracks[0].spotify_id, 'spotify-track');
  assert.equal('apple_music_id' in queue.tracks[0], false);
  assert.equal('apple_music_id' in queue.tracks[0].raw, false);
  assert.equal('apple_music_id' in queue.tracks[0].raw.track, false);
  assert.equal('apple_music_id' in queue.raw, false);
  assert.equal(station.queue.tracks[0].track.apple_music_id, 'track-legacy');
});

test('host profile raw data drops nested Apple Music fields', () => {
  const account = {
    id: 7,
    handle: 'host',
    appleMusic: { id: 'legacy' },
    badges: [{ name: 'badge', apple_music_id: 'badge-legacy' }],
  };
  const profile = normalizeProfile(account, 'fallback');
  assert.equal(profile.handle, 'host');
  assert.equal('appleMusic' in profile.raw, false);
  assert.equal('apple_music_id' in profile.raw.badges[0], false);
  assert.equal(account.appleMusic.id, 'legacy');
});

test('host ingest sanitizes parsed fallback bodies before core persistence', () => {
  const source = readFileSync(new URL('../../site/functions/api/host-ingest.js', import.meta.url), 'utf8');
  assert.match(source, /const body = stripAppleMusicFields\(parsed\.body\)/);
  assert.match(source, /requestWithParsedJson\(request, body\)/);
  assert.doesNotMatch(source, /parsed\.body\?\.data/);
});
