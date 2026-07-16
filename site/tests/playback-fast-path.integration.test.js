import assert from 'node:assert/strict';
import test from 'node:test';

import { secondaryRowNeedsMetadata } from '../functions/api/playback.js';
import {
  loadPrimaryPlaybackPayload,
  PRIMARY_PLAYBACK_STATE_SQL,
} from '../functions/lib/primary-playback.js';

class SingleReadDb {
  constructor(row) {
    this.row = row;
    this.calls = [];
  }

  prepare(sql) {
    this.calls.push(sql);
    return {
      bind() { return this; },
      first: async () => {
        if (sql !== PRIMARY_PLAYBACK_STATE_SQL) throw new Error(`unexpected D1 read: ${sql}`);
        return this.row;
      },
      all: async () => { throw new Error(`unexpected D1 read: ${sql}`); },
    };
  }
}

test('buddies playback uses one D1 read when the embedded queue read model is complete', async () => {
  const now = Date.now();
  const queue = [{
    position: 0,
    queue_track_id: 1,
    stationhead_track_id: 2,
    spotify_id: 'sp1',
    isrc: 'JPTEST1',
    duration_ms: 180_000,
    title: 'Fast Song',
    artist: 'Fast Artist',
    thumbnail_url: 'https://example.invalid/fast.jpg',
  }];
  const db = new SingleReadDb({
    channel_id: 318,
    latest_observed_at: now - 1_000,
    is_broadcasting: 1,
    fact_station_id: 3328626,
    host_account_id: 46,
    host_handle: 'sakurazaka46jp',
    revision_id: 7,
    queue_start_time: now - 30_000,
    is_paused: 0,
    paused_total_ms: 0,
    pause_started_at: null,
    last_observed_at: now - 500,
    current_position: 0,
    queue_station_id: 3328626,
    queue_id: 99,
    structural_hash: 'structural-hash',
    read_model_channel_id: 318,
    read_model_observed_at: now - 500,
    read_model_station_id: 3328626,
    read_model_queue_id: 99,
    read_model_start_time: now - 30_000,
    read_model_is_paused: 0,
    read_model_queue_json: JSON.stringify(queue),
  });

  const payload = await loadPrimaryPlaybackPayload(db, now);

  assert.equal(db.calls.length, 1);
  assert.equal(payload.playing, true);
  assert.equal(payload.queue[0].title, 'Fast Song');
  assert.equal(payload.queue[0].artist, 'Fast Artist');
  assert.equal(payload.queue[0].thumbnail_url, 'https://example.invalid/fast.jpg');
});

test('buddy46 skips metadata D1 reads for already enriched stored queues', () => {
  assert.equal(secondaryRowNeedsMetadata({
    queue_json: JSON.stringify([{
      spotify_id: 'sp1',
      isrc: 'JPTEST1',
      duration_ms: 180_000,
      title: 'Stored Song',
      artist: 'Stored Artist',
      thumbnail_url: 'stored-cover',
    }]),
  }), false);

  assert.equal(secondaryRowNeedsMetadata({
    queue_json: JSON.stringify([{
      spotify_id: 'sp1',
      isrc: 'JPTEST1',
      duration_ms: 180_000,
      title: null,
      artist: null,
      thumbnail_url: null,
    }]),
  }), true);
});
