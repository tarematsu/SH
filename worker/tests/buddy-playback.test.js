import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUDDY_PLAYBACK_TOUCH_SQL,
  BUDDY_PLAYBACK_UPSERT_SQL,
  attachBuddyMetadata,
  collectBuddyPlayback,
  extractBuddyPlayback,
  shouldRunBuddyPlayback,
  validateBuddyChannelPayload,
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
  constructor({ current = null, metadata = [], currentError = null } = {}) {
    this.current = current;
    this.metadata = metadata;
    this.currentError = currentError;
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
    if (kind === 'first' && sql.includes('sh_playback_channel_current')) {
      if (this.currentError) throw this.currentError;
      return this.current;
    }
    if (kind === 'all' && sql.includes('sh_track_metadata')) return { results: this.metadata };
    return { success: true, meta: { changes: 1 } };
  }
}

const metadataRow = {
  spotify_id: 'sp1',
  title: 'Song',
  artist: 'Artist',
  display_title: 'Song — Artist',
  fetched_at: 300_000,
};

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
        track: {
          id: 2,
          spotify_id: 'sp1',
          duration: 180_000,
          isrc: 'JPX',
          bite_count: 999,
        },
      }],
    },
  },
};

function expectedQueueJson(metadata = metadataRow) {
  const queue = extractBuddyPlayback(channel);
  return JSON.stringify(attachBuddyMetadata(queue, new Map([['sp1', metadata]])));
}

function currentDisplayState(overrides = {}) {
  return {
    is_broadcasting: 1,
    host_account_id: 9,
    host_handle: 'host46',
    ...overrides,
  };
}

test('buddy playback runs only in five-minute buckets', () => {
  assert.equal(shouldRunBuddyPlayback(0, 300_000), true);
  assert.equal(shouldRunBuddyPlayback(240_000, 300_000), false);
  assert.equal(shouldRunBuddyPlayback(300_000, 300_000), true);
});

test('buddy playback extracts a compact queue without converting nulls to zero', () => {
  const value = extractBuddyPlayback(channel);
  assert.equal(value.station_id, 46);
  assert.equal(value.queue_id, 99);
  assert.equal(value.is_broadcasting, true);
  assert.equal(value.tracks[0].spotify_id, 'sp1');
  assert.equal('bite_count' in value.tracks[0], false);

  const empty = extractBuddyPlayback({
    alias: 'buddy46',
    current_station_id: null,
    current_station: {
      is_broadcasting: 'false',
      queue: { id: null, start_time: null, is_paused: 'false', queue_tracks: [] },
    },
  });
  assert.equal(empty.station_id, null);
  assert.equal(empty.queue_id, null);
  assert.equal(empty.start_time, null);
  assert.equal(empty.is_paused, false);
  assert.equal(empty.is_broadcasting, false);
});

test('buddy playback rejects malformed channel payloads before replacing current state', () => {
  assert.throws(
    () => validateBuddyChannelPayload({ current_station: null }, 'buddy46'),
    /missing channel alias/,
  );
  assert.throws(
    () => validateBuddyChannelPayload({ alias: 'other', current_station: null }, 'buddy46'),
    /alias mismatch/,
  );
});

test('changed playback replaces the one current-state row with compact JSON', async () => {
  const db = new FakeDb();
  const result = await collectBuddyPlayback({ DB: db }, 600_000, {
    loadSession: async () => ({ authToken: 'token', deviceUid: 'device' }),
    fetchChannel: async () => channel,
    stateHash: async () => 'hash-new',
    fetchTrackMetadata: async () => ({
      ...metadataRow,
      thumbnail_url: 'cover',
      spotify_url: 'spotify',
      source: 'spotify_oembed',
      fetched_at: 600_000,
      raw: { oversized: 'not copied into queue JSON' },
    }),
  });

  assert.equal(result.playback_changed, true);
  const upsert = db.calls.find((call) => call.sql === BUDDY_PLAYBACK_UPSERT_SQL);
  assert.ok(upsert);
  assert.match(upsert.params[9], /Song/);
  assert.doesNotMatch(upsert.params[9], /metadata_raw_json|metadata_fetched_at|bite_count|oversized/);
  assert.equal(db.calls.some((call) => call.sql === BUDDY_PLAYBACK_TOUCH_SQL), false);
});

test('metadata-only refresh updates queue JSON without resetting playback changed_at', async () => {
  const db = new FakeDb({
    current: {
      ...currentDisplayState(),
      state_hash: 'same',
      queue_json: '[]',
      checked_at: 300_000,
      changed_at: 123_000,
    },
    metadata: [metadataRow],
  });
  const result = await collectBuddyPlayback({ DB: db }, 600_000, {
    loadSession: async () => ({ authToken: 'token', deviceUid: 'device' }),
    fetchChannel: async () => channel,
    stateHash: async () => 'same',
  });

  assert.equal(result.playback_changed, false);
  assert.equal(result.content_changed, true);
  assert.equal(result.display_changed, false);
  const upsert = db.calls.find((call) => call.sql === BUDDY_PLAYBACK_UPSERT_SQL);
  assert.ok(upsert);
  assert.equal(upsert.params[11], 123_000);
});

test('broadcast-only changes update display state without moving the playback anchor', async () => {
  const db = new FakeDb({
    current: {
      ...currentDisplayState({ is_broadcasting: 0 }),
      state_hash: 'same',
      queue_json: expectedQueueJson(),
      checked_at: 300_000,
      changed_at: 123_000,
    },
    metadata: [metadataRow],
  });
  const result = await collectBuddyPlayback({ DB: db }, 600_000, {
    loadSession: async () => ({ authToken: 'token', deviceUid: 'device' }),
    fetchChannel: async () => channel,
    stateHash: async () => 'same',
  });

  assert.equal(result.playback_changed, false);
  assert.equal(result.content_changed, false);
  assert.equal(result.display_changed, true);
  const upsert = db.calls.find((call) => call.sql === BUDDY_PLAYBACK_UPSERT_SQL);
  assert.ok(upsert);
  assert.equal(upsert.params[11], 123_000);
});

test('unchanged playback updates only checked_at', async () => {
  const db = new FakeDb({
    current: {
      ...currentDisplayState(),
      state_hash: 'same',
      queue_json: expectedQueueJson(),
      checked_at: 300_000,
      changed_at: 300_000,
    },
    metadata: [metadataRow],
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

test('missing current-state table skips collection before external requests', async () => {
  const db = new FakeDb({ currentError: new Error('no such table: sh_playback_channel_current') });
  let loadedSession = false;
  const result = await collectBuddyPlayback({ DB: db }, 600_000, {
    loadSession: async () => {
      loadedSession = true;
      return { authToken: 'token', deviceUid: 'device' };
    },
  });

  assert.deepEqual(result, { skipped: true, reason: 'playback-table-setup-required' });
  assert.equal(loadedSession, false);
});
