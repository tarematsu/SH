import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTrackDescriptor,
  missingRevisionPositions,
  resolveTracksBulk,
} from '../src/minute-facts-fast-store.js';
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
  assert.ok(db.allCalls <= 18, `expected at most 18 read round trips, got ${db.allCalls}`);
  assert.ok(db.batchCalls <= 15, `expected at most 15 batch round trips, got ${db.batchCalls}`);
});

test('optimized minute storage uses the canonical counter log for bite changes', () => {
  const source = readFileSync(path.resolve(import.meta.dirname, '../src/minute-facts-fast-store.js'), 'utf8');
  assert.match(source, /writeCurrentBite/);
  assert.doesNotMatch(source, /sh_track_bite_observations/);
});
