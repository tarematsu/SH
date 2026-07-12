import assert from 'node:assert/strict';
import test from 'node:test';

import { queueStructuralPayload } from '../functions/lib/d1-lean-ingest.js';
import { inferArtistFromDisplayTitle, normalizePlaybackTrack } from '../functions/lib/playback.js';

test('queue structural payload keeps Spotify fields and ignores non-Spotify IDs', () => {
  const payload = queueStructuralPayload({
    station_id: 1,
    queue_id: 2,
    start_time: 3,
    tracks: [{
      position: 0,
      queue_track_id: 10,
      stationhead_track_id: 20,
      spotify_id: 'sp1',
      apple_music_id: 'ignored',
      deezer_id: 'dz1',
      isrc: 'JPTEST',
      duration_ms: 180000,
    }],
  });

  assert.equal(payload.tracks[0].spotify_id, 'sp1');
  assert.equal('apple_music_id' in payload.tracks[0], false);
});

test('playback track output omits non-Spotify IDs even when present in old rows', () => {
  const track = normalizePlaybackTrack({
    observed_at: 100,
    station_id: 1,
    queue_id: 2,
    start_time: 3,
    position: 0,
    queue_track_id: 10,
    stationhead_track_id: 20,
    spotify_id: 'sp1',
    apple_music_id: 'old-value',
    duration_ms: 180000,
    title: 'Song',
    artist: 'Artist',
  }, 0, { currentIndex: 0, progressMs: 123 });

  assert.equal(track.spotify_id, 'sp1');
  assert.equal('apple_music_id' in track, false);
});

test('playback derives artist from UTF-8 dash-separated display titles', () => {
  assert.equal(inferArtistFromDisplayTitle('Song \u2014 Artist', 'Song'), 'Artist');
});
