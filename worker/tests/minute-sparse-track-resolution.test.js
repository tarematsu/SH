import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveSparseTracks,
  sparseAliasLookupShape,
} from '../src/minute-sparse-track-resolution.js';

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new Statement(this.db, this.sql, args);
  }

  async first() {
    this.db.lookups.push({ sql: this.sql, args: this.args });
    return { id: 42 };
  }

  async run() {
    this.db.runs.push({ sql: this.sql, args: this.args });
    return { meta: { changes: 1 } };
  }
}

class FakeDb {
  constructor() {
    this.lookups = [];
    this.runs = [];
    this.batches = [];
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    this.batches.push(statements.map((statement) => ({ sql: statement.sql, args: statement.args })));
    return statements.map(() => ({ success: true }));
  }
}

const track = {
  position: 7,
  queue_track_id: 70,
  stationhead_track_id: 700,
  spotify_id: 'spotify-700',
  isrc: 'jptest000700',
  title: 'Song',
  artist: 'Artist',
  duration_ms: 180_000,
};

test('sparse lookup keeps alias precedence in one D1 query', () => {
  const shape = sparseAliasLookupShape(track);
  assert.deepEqual(shape.aliases.map(({ type }) => type), [
    'isrc',
    'spotify_id',
    'stationhead_track_id',
    'legacy_name',
  ]);
  assert.equal(shape.direct.isrc, 'JPTEST000700');
  assert.equal(shape.direct.spotify_id, 'spotify-700');
  assert.equal(shape.direct.stationhead_track_id, 700);
});

test('one sparse track performs indexed union probes and one update batch', async () => {
  const db = new FakeDb();
  const [resolved] = await resolveSparseTracks(db, null, [track], 1_000);

  assert.equal(resolved.trackId, 42);
  assert.equal(db.lookups.length, 1);
  const lookup = db.lookups[0];
  assert.match(lookup.sql, /wanted\(ord,alias_type,alias_value\)/);
  assert.match(lookup.sql, /JOIN sh_track_aliases/);
  assert.match(lookup.sql, /FROM sh_tracks WHERE isrc=\?/);
  assert.match(lookup.sql, /FROM sh_tracks WHERE spotify_id=\?/);
  assert.match(lookup.sql, /FROM sh_tracks WHERE stationhead_track_id=\?/);
  assert.match(lookup.sql, /FROM sh_tracks WHERE canonical_key=\?/);
  assert.doesNotMatch(lookup.sql, /isrc=\?\s+OR\s+spotify_id=/);
  assert.ok((lookup.sql.match(/UNION ALL/g) || []).length >= 4);
  assert.deepEqual(lookup.args.slice(-4), [
    'JPTEST000700',
    'spotify-700',
    700,
    resolved.canonicalKey,
  ]);
  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0][0].args.at(-1), 42);
  assert.equal(db.batches[0].length, 1 + resolved.aliases.length);
});
