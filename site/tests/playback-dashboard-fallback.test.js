import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PLAYBACK_FALLBACK_SNAPSHOT_SQL,
  preferDashboardAlignedPlayback,
} from '../functions/lib/primary-playback-fallback.js';
import { LATEST_QUEUE_WITH_ITEMS_SQL } from '../functions/lib/latest-queue.js';

class DashboardFallbackDb {
  constructor({ snapshot, queueRows }) {
    this.snapshot = snapshot;
    this.queueRows = queueRows;
    this.calls = [];
  }

  prepare(sql) {
    this.calls.push(sql);
    return {
      bind() { return this; },
      first: async () => {
        if (sql === PLAYBACK_FALLBACK_SNAPSHOT_SQL) return this.snapshot;
        throw new Error(`unexpected first(): ${sql}`);
      },
      all: async () => {
        if (sql === LATEST_QUEUE_WITH_ITEMS_SQL) return { results: this.queueRows };
        throw new Error(`unexpected all(): ${sql}`);
      },
    };
  }
}

function queueRow(overrides = {}) {
  return {
    queue_station_id: 3328626,
    queue_id: 77,
    queue_start_time: 1_799_999_970_000,
    queue_is_paused: 0,
    queue_observed_at: 1_799_999_999_500,
    item_observed_at: 1_799_999_999_500,
    position: 0,
    queue_track_id: 10,
    stationhead_track_id: 20,
    spotify_id: 'sp-current',
    deezer_id: null,
    isrc: 'JPTESTCURRENT',
    duration_ms: 180_000,
    preview_url: null,
    bite_count: 4,
    title: 'Current Song',
    artist: 'Current Artist',
    display_title: 'Current Song - Current Artist',
    thumbnail_url: 'https://example.invalid/current.jpg',
    spotify_url: null,
    metadata_fetched_at: 1_799_999_999_000,
    metadata_raw_json: null,
    ...overrides,
  };
}

test('stale primary playback is replaced by the same buddies DB queue used by dashboard?history=0', async () => {
  const now = 1_800_000_000_000;
  const db = new DashboardFallbackDb({
    snapshot: {
      observed_at: now - 1_000,
      channel_id: 318,
      station_id: 3328626,
      is_broadcasting: 1,
      host_account_id: 3334889,
      host_handle: 'sakuramankai',
    },
    queueRows: [
      queueRow(),
      queueRow({
        position: 1,
        queue_track_id: 11,
        stationhead_track_id: 21,
        spotify_id: 'sp-next',
        isrc: 'JPTESTNEXT',
        duration_ms: 200_000,
        title: 'Next Song',
        artist: 'Next Artist',
        display_title: 'Next Song - Next Artist',
        thumbnail_url: 'https://example.invalid/next.jpg',
      }),
    ],
  });
  const primary = {
    ok: true,
    stale: true,
    latest_observed_at: now - 18 * 60 * 60_000,
    queue_observed_at: now - 17 * 60 * 60_000,
    queue_status: { current_index: -1, ended: true },
    queue: [{ title: 'Old Song', duration_ms: 1 }],
  };

  const payload = await preferDashboardAlignedPlayback(db, primary, now);

  assert.equal(payload.latest_observed_at, now - 1_000);
  assert.equal(payload.queue_observed_at, now - 500);
  assert.equal(payload.stale, false);
  assert.equal(payload.playing, true);
  assert.equal(payload.queue_status.current_index, 0);
  assert.equal(payload.queue_status.ended, undefined);
  assert.equal(payload.queue[0].title, 'Current Song');
  assert.equal(payload.queue[0].is_current, true);
  assert.equal(payload.queue[1].title, 'Next Song');
  assert.deepEqual(db.calls.sort(), [
    LATEST_QUEUE_WITH_ITEMS_SQL,
    PLAYBACK_FALLBACK_SNAPSHOT_SQL,
  ].sort());
});

test('fresh primary playback avoids extra buddies DB reads', async () => {
  const db = new DashboardFallbackDb({ snapshot: null, queueRows: [] });
  const primary = {
    ok: true,
    stale: false,
    latest_observed_at: 100,
    queue_observed_at: 100,
    queue: [],
  };

  assert.equal(await preferDashboardAlignedPlayback(db, primary, 200), primary);
  assert.deepEqual(db.calls, []);
});
