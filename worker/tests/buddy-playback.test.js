import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUDDY_PLAYBACK_TOUCH_SQL,
  BUDDY_PLAYBACK_UPSERT_SQL,
  collectBuddyPlayback,
  extractBuddyPlayback,
  shouldRunBuddyPlayback,
} from '../src/buddy-playback.js';

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  first() {
    return this.db.resolve('first', this.sql, this.params);
  }

  all() {
    return this.db.resolve('all', this.sql, this.params);
  }

  run() {
    return this.db.resolve('run', this.sql, this.params);
  }
}

class FakeDb {
  constructor({ current = null, metadata = [] } = {}) {
    this.current = current;
    this.metadata = metadata;
    this.calls = [];
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }

  async resolve(kind, sql, params) {
    this.calls.push({ kind, sql, params });
    if (kind === 'first' && sql.includes('sh_worker_collector_state')) {
      return { auth_token: 'token', device_uid: 'device' };
    }
    if (kind === 'first' && sql.includes('sh_playback_channel_current')) return this.current;
    if (kind === 'all' && sql.includes('sh_track_metadata')) return { results: this.metadata };
    return { success: true, meta: { changes: 1 } };
  }
}

const channel = {
  alias: 'buddy46',
  current_station: {
    id: 46,
    is_broadcasting: true,
    broadcast: {
      broadcasters: [{ is_host: true, account_id: 9, account: { handle: 'host46' } }],
    },
    queue: {
      id: 99,
      station_id: 46,
      start_time: 300_000,
      is_paused: false,
      queue_tracks: [{
        id: 1,
        track: { id: 2, spotify_id: 'sp1', duration: 180_000, isrc: 'JPX' },
      }],
    },
  },
};

test('buddy playback runs only in five-minute buckets', () => {
  assert.equal(shouldRunBuddyPlayback(0, 300_000), true);
  assert.equal(shouldRunBuddyPlayback(240_000, 300_000), false);
  assert.equal(shouldRunBuddyPlayback(300_000, 300_000), true);
});

test('buddy playback extracts a compact queue', () => {
  const value = extractBuddyPlayback(channel);
  assert.equal(value.station_id, 46);
  assert.equal(value.queue_id, 99);
  assert.equal(value.is_broadcasting, true);
  assert.equal(value.tracks[0].spotify_id, 'sp1');
});

test('changed playback replaces the one current-state row', async () => {
  const db = new FakeDb();
  const result = await collectBuddyPlayback({ DB: db }, 600_000, {
    loadSession: async () => ({ authToken: 'token', deviceUid: 'device' }),
    fetchChannel: async () => channel,
    stateHash: async () => 'hash-new',
    fetchTrackMetadata: async () => ({
      spotify_id: 'sp1',
      title: 'Song',
      artist: 'Artist',
      display_title: 'Song — Artist',
      thumbnail_url: 'cover',
      spotify_url: 'spotify',
      source: 'spotify_oembed',
      fetched_at: 600_000,
      raw: {},
    }),
  });

  assert.equal(result.changed, true);
  const upsert = db.calls.find((call) => call.sql === BUDDY_PLAYBACK_UPSERT_SQL);
  assert.ok(upsert);
  assert.match(upsert.params[9], /Song/);
  assert.equal(db.calls.some((call) => call.sql === BUDDY_PLAYBACK_TOUCH_SQL), false);
});

test('unchanged playback updates only checked_at', async () => {
  const db = new FakeDb({
    current: { state_hash: 'same', checked_at: 300_000 },
    metadata: [{
      spotify_id: 'sp1',
      title: 'Song',
      artist: 'Artist',
      display_title: 'Song — Artist',
      fetched_at: 300_000,
    }],
  });
  const result = await collectBuddyPlayback({ DB: db }, 600_000, {
    loadSession: async () => ({ authToken: 'token', deviceUid: 'device' }),
    fetchChannel: async () => channel,
    stateHash: async () => 'same',
  });

  assert.equal(result.changed, false);
  assert.ok(db.calls.find((call) => call.sql === BUDDY_PLAYBACK_TOUCH_SQL));
  assert.equal(db.calls.some((call) => call.sql === BUDDY_PLAYBACK_UPSERT_SQL), false);
});
