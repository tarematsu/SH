import assert from 'node:assert/strict';
import test from 'node:test';

import { minuteFactQueue, minuteFactSnapshot } from '../src/collector-payload.js';

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
      { position: 0, spotify_id: 'a' },
      { position: 1, spotify_id: 'b' },
    ],
  });
  assert.equal(minuteFactQueue(null), null);
});
