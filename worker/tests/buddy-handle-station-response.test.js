import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buddyHandleStationPath,
  extractBuddyPlayback,
  validateBuddyChannelPayload,
} from '../src/buddy-playback.js';
import { normalizeBuddyQueuePayload } from '../src/buddy-fetch-guard.js';

const discoveredHandleResponse = {
  status: 'Stream for Sakurazaka46',
  share_url: 'stationhead://station/3858517',
  is_launched: true,
  listener_count: 1,
  total_listens: 191390,
  guest_count: 1,
  chat_status: 'enabled',
  is_broadcasting: true,
  broadcast: {
    station_id: 3858517,
    broadcasters: [{
      is_host: true,
      account_id: 3864866,
      account: { handle: 'buddy46', id: 3864866 },
    }],
  },
  queue: {
    start_time: 1783349967165,
    is_paused: false,
    station_id: 3858517,
    id: 3858517,
    queue_tracks: [{
      id: 5000967664,
      track: {
        spotify_id: '3V0aOhJIgKTkzJy7uonAOz',
        apple_music_id: 'example-non-spotify-id',
        deezer_id: '1508616832',
        duration: 273653,
        isrc: 'JPU902102712',
        preview: 'https://example.invalid/preview.m4a',
        id: 24124293,
      },
    }],
  },
  id: 3858517,
  type: 'station',
};

test('buddy46 collector targets the personal handle station endpoint', () => {
  assert.equal(buddyHandleStationPath('buddy46'), '/station/handle/buddy46/guest');
});

test('discovered handle station response validates and extracts Spotify-only playback', () => {
  const normalized = normalizeBuddyQueuePayload(discoveredHandleResponse, 'buddy46');
  assert.equal(normalized.alias, 'buddy46');
  assert.doesNotThrow(() => validateBuddyChannelPayload(normalized, 'buddy46'));

  const playback = extractBuddyPlayback(normalized, 'buddy46');
  assert.equal(playback.station_id, 3858517);
  assert.equal(playback.queue_id, 3858517);
  assert.equal(playback.start_time, 1783349967165);
  assert.equal(playback.is_broadcasting, true);
  assert.equal(playback.host_account_id, 3864866);
  assert.equal(playback.host_handle, 'buddy46');
  assert.equal(playback.tracks.length, 1);
  assert.equal(playback.tracks[0].queue_track_id, 5000967664);
  assert.equal(playback.tracks[0].stationhead_track_id, 24124293);
  assert.equal(playback.tracks[0].spotify_id, '3V0aOhJIgKTkzJy7uonAOz');
  assert.equal('apple_music_id' in playback.tracks[0], false);
});
