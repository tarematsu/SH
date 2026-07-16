import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachMinuteFactQueueMetadata,
  extractQueue,
  minuteFactQueue,
  minuteFactSnapshot,
  normalizeSnapshot,
  readModelPresentation,
} from '../src/collector-payload.js';

test('minuteFactSnapshot strips the embedded raw channel payload', () => {
  const snapshot = { channel_id: 10, listener_count: 42, raw: { huge: 'channel payload' } };
  assert.deepEqual(minuteFactSnapshot(snapshot), { channel_id: 10, listener_count: 42 });
  assert.equal(minuteFactSnapshot(null), null);
});

test('normalizeSnapshot keeps only compact presentation data for downstream work', () => {
  const snapshot = normalizeSnapshot({
    id: 10,
    alias: 'buddies',
    description: 'Channel',
    images: { medium: { url: 'https://example.com/channel.jpg' } },
    current_station: {
      id: 20,
      status: 'Live',
      streaming_party: { stream_goal: 100, current_stream_count: 25 },
      owner: { thumbnail: { url: 'https://example.com/thumb.jpg' } },
    },
  }, { channelId: 10, stationId: 20 }, { channelAlias: 'buddies' });

  assert.equal('raw' in snapshot, false);
  assert.equal(minuteFactSnapshot(snapshot).presentation, undefined);
  assert.strictEqual(readModelPresentation(snapshot), snapshot.presentation);
  assert.equal(readModelPresentation(snapshot).description, 'Channel');
  assert.equal(readModelPresentation(snapshot).current_station.streaming_party.current_stream_count, 25);
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

test('extractQueue emits a compact queue that retains playback presentation', () => {
  const queue = extractQueue({
    current_station: {
      id: 5,
      queue: {
        id: 9,
        queue_tracks: [{
          id: 3,
          track: {
            id: 7,
            spotify_id: 'spotify-7',
            title: 'Song',
            artist: { name: 'Artist' },
            album: { name: 'Album', image_url: 'https://example.com/album.jpg' },
            duration: 180_000,
          },
        }],
      },
    },
  }, 5);

  assert.equal('raw' in queue, false);
  assert.equal('raw' in queue.tracks[0], false);
  assert.equal(minuteFactQueue(queue), queue);
  assert.deepEqual(queue.tracks[0], {
    position: 0,
    queue_track_id: 3,
    stationhead_track_id: 7,
    spotify_id: 'spotify-7',
    deezer_id: null,
    isrc: null,
    duration_ms: 180_000,
    preview_url: null,
    bite_count: null,
    title: 'Song',
    artist: 'Artist',
    album_name: 'Album',
    thumbnail_url: 'https://example.com/album.jpg',
  });
  Object.defineProperty(queue, 'tracks', {
    configurable: true,
    get() { throw new Error('compact tracks must not be inspected again'); },
  });
  assert.strictEqual(minuteFactQueue(queue), queue);
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

test('attachMinuteFactQueueMetadata fills missing presentation fields without overwriting upstream values', () => {
  const queue = {
    tracks: [
      { spotify_id: 'a', title: null, artist: null, album_name: null, thumbnail_url: null },
      { spotify_id: 'b', title: 'Upstream title', artist: null, thumbnail_url: null },
      { spotify_id: 'missing', title: null },
    ],
  };
  const hydrated = attachMinuteFactQueueMetadata(queue, [
    { spotify_id: 'a', title: 'Stored title', artist: 'Stored artist', thumbnail_url: 'https://example.com/a.jpg' },
    { spotify_id: 'b', title: 'Stored replacement', artist: 'Stored artist B' },
  ]);
  assert.deepEqual(hydrated.tracks[0], {
    spotify_id: 'a',
    title: 'Stored title',
    artist: 'Stored artist',
    album_name: null,
    thumbnail_url: 'https://example.com/a.jpg',
  });
  assert.equal(hydrated.tracks[1].title, 'Upstream title');
  assert.equal(hydrated.tracks[1].artist, 'Stored artist B');
  assert.deepEqual(hydrated.tracks[2], queue.tracks[2]);
});
