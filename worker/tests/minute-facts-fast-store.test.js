import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTrackDescriptor,
  missingRevisionPositions,
  resolveTracksBulk,
} from '../src/minute-facts-fast-store.js';
import { updatePlaybackState, writeCurrentBite } from '../src/minute-facts-legacy-revision.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

class FakeStatement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new FakeStatement(this.db, this.sql, args);
  }

  async all() {
    this.db.allCalls += 1;
    if (this.sql.includes('FROM sh_track_aliases')) return { results: [] };
    if (this.sql.includes('FROM sh_tracks')) {
      const match = this.sql.match(/SELECT id,(canonical_key|isrc|spotify_id) AS lookup_value/);
      const column = match?.[1];
      if (!column) return { results: [] };
      const requested = new Set(this.args.map(String));
      return {
        results: [...this.db.tracks.values()]
          .filter((row) => row[column] != null && requested.has(String(row[column])))
          .map((row) => ({ id: row.id, lookup_value: row[column] })),
      };
    }
    return { results: [] };
  }

  async first() {
    this.db.firstCalls += 1;
    return null;
  }

  async run() {
    this.db.runStatement(this);
    return { meta: { changes: 1 } };
  }
}

class FakeDb {
  constructor() {
    this.allCalls = 0;
    this.firstCalls = 0;
    this.batchCalls = 0;
    this.nextTrackId = 1;
    this.tracks = new Map();
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  runStatement(statement) {
    if (!statement.sql.includes('INSERT OR IGNORE INTO sh_tracks')) return;
    const [canonicalKey, isrc, spotifyId, stationheadTrackId, title, artist, firstSeenAt, lastSeenAt] = statement.args;
    if (this.tracks.has(canonicalKey)) return;
    this.tracks.set(canonicalKey, {
      id: this.nextTrackId++,
      canonical_key: canonicalKey,
      isrc,
      spotify_id: spotifyId,
      stationhead_track_id: stationheadTrackId,
      title,
      artist,
      first_seen_at: firstSeenAt,
      last_seen_at: lastSeenAt,
    });
  }

  async batch(statements) {
    this.batchCalls += 1;
    for (const statement of statements) this.runStatement(statement);
    return statements.map(() => ({ success: true }));
  }
}

test('track descriptors normalize stable aliases in priority order', () => {
  const descriptor = buildTrackDescriptor({
    position: 4,
    isrc: 'jp-test-01',
    spotify_id: 'spotify-1',
    stationhead_track_id: 42,
  }, {
    title: 'Test Song',
    artist: 'Test Artist',
  });

  assert.equal(descriptor.position, 4);
  assert.equal(descriptor.isrc, 'JP-TEST-01');
  assert.equal(descriptor.canonicalKey, 'isrc:JP-TEST-01');
  assert.deepEqual(descriptor.aliases.slice(0, 3), [
    { type: 'isrc', value: 'JP-TEST-01' },
    { type: 'spotify_id', value: 'spotify-1' },
    { type: 'stationhead_track_id', value: '42' },
  ]);
  assert.equal(descriptor.title, 'Test Song');
  assert.equal(descriptor.artist, 'Test Artist');
});

test('pending revisions resume only positions that were not already written', () => {
  const tracks = [
    { position: 0 },
    { position: 1 },
    { position: 2 },
    { position: 3 },
  ];
  assert.deepEqual(
    missingRevisionPositions(tracks, [{ position: 0 }, { position: 2 }]).map((track) => track.position),
    [1, 3],
  );
});

test('99 tracks are resolved with bounded D1 round trips instead of per-track awaits', async () => {
  const db = new FakeDb();
  const tracks = Array.from({ length: 99 }, (_, index) => ({
    position: index,
    isrc: `JPTEST${String(index).padStart(5, '0')}`,
    spotify_id: `spotify-${index}`,
    stationhead_track_id: 10_000 + index,
    duration_ms: 180_000,
  }));

  const resolved = await resolveTracksBulk(db, null, tracks, 1_000_000, {
    channelId: 318,
    minuteAt: 960_000,
    queueTracks: tracks.length,
  });

  assert.equal(resolved.length, 99);
  assert.equal(resolved.every((track) => Number.isFinite(track.trackId)), true);
  assert.equal(db.tracks.size, 99);
  assert.ok(db.allCalls <= 20, `expected at most 20 read round trips, got ${db.allCalls}`);
  assert.ok(db.batchCalls <= 15, `expected at most 15 batch round trips, got ${db.batchCalls}`);
});

test('delayed playback payloads never reuse a later current position', async () => {
  let writes = 0;
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          assert.match(sql, /sh_playback_current/);
          return {
            revision_id: 9,
            current_position: 12,
            last_observed_at: 20_000,
          };
        },
        async run() { writes += 1; },
      };
    },
  };

  const result = await updatePlaybackState(db, {
    channelId: 10,
    sessionId: 20,
    revisionId: 8,
    queueStartTime: 1_000,
    observedAt: 19_000,
    isPaused: false,
  });

  assert.equal(result.delayed, true);
  assert.equal(result.current_position, null);
  assert.equal(writes, 0);
});

test('revision changes within one queue preserve pause time and load only the current item', async () => {
  let playbackParams = null;
  const previous = {
    session_id: 20,
    revision_id: 7,
    queue_start_time: 1_000,
    is_paused: 0,
    paused_total_ms: 5_000,
    pause_started_at: null,
    last_observed_at: 11_000,
    current_position: 0,
  };
  const db = {
    prepare(sql) {
      const statement = {
        params: [],
        bind(...params) { this.params = params; return this; },
        async first() {
          if (sql.includes('SELECT * FROM sh_playback_current')) return previous;
          if (sql.includes('FROM sh_queue_revision_items')) {
            assert.match(sql, /playback_offset_ms<=\?/);
            assert.match(sql, /LIMIT 1/);
            return { position: 0, track_id: 31, schedule_valid: 1 };
          }
          throw new Error(`unexpected first: ${sql}`);
        },
        async run() {
          if (sql.includes('INSERT INTO sh_playback_current')) playbackParams = this.params;
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  };

  const result = await updatePlaybackState(db, {
    channelId: 10,
    sessionId: 20,
    revisionId: 8,
    queueStartTime: 1_000,
    observedAt: 12_000,
    isPaused: false,
  });

  assert.equal(result.current_position, 0);
  assert.equal(result.current_track_id, 31);
  assert.equal(result.current_schedule_valid, 1);
  assert.equal(playbackParams[5], 5_000);
});

test('current bite reuses the resolved track and indexed queue entry', async () => {
  const queries = [];
  let insertParams = null;
  const db = {
    prepare(sql) {
      queries.push(sql);
      return {
        params: [],
        bind(...params) { this.params = params; return this; },
        async first() {
          if (sql.includes('FROM sh_track_counter_changes')) return { count_value: 6 };
          throw new Error(`unexpected first: ${sql}`);
        },
        async run() {
          if (sql.includes('INSERT OR IGNORE INTO sh_track_counter_changes')) insertParams = this.params;
          return { meta: { changes: 1 } };
        },
      };
    },
  };

  const result = await writeCurrentBite(db, {
    channelId: 10,
    stationId: 20,
    revisionId: 30,
    position: 0,
    trackId: 42,
    observedAt: 50_000,
    queue: {
      queue_id: 40,
      start_time: 1_700_000_000,
      tracks: [{ position: 0, queue_track_id: 77, bite_count: 7 }],
    },
  });

  assert.equal(result, 7);
  assert.equal(queries.some((sql) => sql.includes('FROM sh_queue_revision_items')), false);
  assert.equal(insertParams[13], 42);
});

test('optimized minute storage uses canonical playback and counter logic', () => {
  const source = readFileSync(path.resolve(import.meta.dirname, '../src/minute-facts-fast-store.js'), 'utf8');
  assert.match(source, /updatePlaybackState, writeCurrentBite/);
  assert.doesNotMatch(source, /async function updatePlaybackState/);
  assert.match(source, /writeCurrentBite/);
  assert.doesNotMatch(source, /sh_queue_revision_items/);
  assert.doesNotMatch(source, /sh_track_bite_observations/);
});
