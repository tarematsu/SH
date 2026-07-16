import assert from 'node:assert/strict';
import test from 'node:test';

import { queueRevisionItemStatement } from '../src/minute-facts-normalize.js';

test('queue revision item binds bite count as the twelfth value', () => {
  let bound = null;
  const statement = { bind: (...values) => { bound = values; return statement; } };
  const db = { prepare: () => statement };

  queueRevisionItemStatement(db, 7, {
    position: 2,
    trackId: 11,
    queue_track_id: 22,
    stationhead_track_id: 33,
    isrc: 'JP-TEST',
    spotify_id: 'spotify',
    deezer_id: 'deezer',
    duration_ms: 180000,
    playbackOffset: 360000,
    scheduleValid: true,
  }, 44);

  assert.equal(bound.length, 12);
  assert.equal(bound[11], 44);
});
