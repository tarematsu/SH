import assert from 'node:assert/strict';
import test from 'node:test';

import { minuteFactQueue, minuteFactSnapshot, readModelPresentation } from '../src/collector-payload.js';

test('minuteFactSnapshot strips the embedded raw channel payload', () => {
  const snapshot = { channel_id: 10, listener_count: 42, raw: { huge: 'channel payload' } };
  assert.deepEqual(minuteFactSnapshot(snapshot), { channel_id: 10, listener_count: 42 });
  assert.equal(minuteFactSnapshot(null), null);
});

test('minuteFactQueue strips the queue raw payload and each track raw payload', () => {
  const queue = {
    station_id: 5,
    queue_id: 9,
    raw: { huge: 'queue payload' },
    tracks: [
      { position: 0, spotify_id: 'a', raw: { huge: 'track payload' } },
      { position: 1, spotify_id: 'b', raw: { huge: 'track payload 2' } },
    ],
  };
  assert.deepEqual(minuteFactQueue(queue), {
    station_id: 5,
    queue_id: 9,
    tracks: [
      { position: 0, spotify_id: 'a', title: null, artist: null, album_name: null, thumbnail_url: null },
      { position: 1, spotify_id: 'b', title: null, artist: null, album_name: null, thumbnail_url: null },
    ],
  });
  assert.equal(minuteFactQueue(null), null);
});

test('read models retain bounded channel and track presentation fields without raw payloads', () => {
  const presentation = readModelPresentation({
    channel_id: 10,
    raw: {
      description: 'Buddies channel',
      artist_name: 'Buddies Artist',
      accent_color: '#123456',
      images: {
        medium: { url: 'https://example.com/channel.jpg' },
        logo: { medium: { url: 'https://example.com/logo.jpg' } },
      },
      current_station: {
        status: 'Live now',
        streaming_party: { stream_goal: 1_000, current_stream_count: 500 },
        owner: {
          thumbnail: { url: 'https://example.com/host-thumb.jpg' },
          medium: { url: 'https://example.com/host.jpg' },
        },
      },
    },
  });
  assert.equal(presentation.description, 'Buddies channel');
  assert.equal(presentation.artist_name, 'Buddies Artist');
  assert.equal(presentation.accent_color, '#123456');
  assert.equal(presentation.images.medium.url, 'https://example.com/channel.jpg');
  assert.equal(presentation.images.logo.medium.url, 'https://example.com/logo.jpg');
  assert.equal(presentation.current_station.status, 'Live now');
  assert.equal(presentation.current_station.streaming_party.stream_goal, 1_000);
  assert.equal(presentation.current_station.owner.thumbnail.url, 'https://example.com/host-thumb.jpg');
  assert.equal(presentation.current_station.owner.medium.url, 'https://example.com/host.jpg');
  assert.equal('raw' in presentation, false);

  const queue = minuteFactQueue({
    tracks: [{
      position: 0,
      raw: {
        track: {
          title: 'Song',
          artist: { name: 'Artist' },
          album: { name: 'Album', image_url: 'https://example.com/album.jpg' },
        },
      },
    }],
  });
  assert.deepEqual(queue.tracks[0], {
    position: 0,
    title: 'Song',
    artist: 'Artist',
    album_name: 'Album',
    thumbnail_url: 'https://example.com/album.jpg',
  });
});
