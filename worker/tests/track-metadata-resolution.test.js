import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { resolveTracksBulk } from '../src/minute-facts-fast-store.js';

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
    if (this.sql.includes('FROM sh_track_metadata')) {
      this.db.metadataQueries += 1;
      const requested = new Set(this.args.map(String));
      return {
        results: [...this.db.metadata.values()]
          .filter((row) => requested.has(String(row.spotify_id))),
      };
    }
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

  async run() {
    this.db.runStatement(this);
    return { meta: { changes: 1 } };
  }
}

class FakeDb {
  constructor(metadata = []) {
    this.metadata = new Map(metadata.map((row) => [String(row.spotify_id), row]));
    this.metadataQueries = 0;
    this.tracks = new Map();
    this.nextTrackId = 1;
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
    for (const statement of statements) this.runStatement(statement);
    return statements.map(() => ({ success: true }));
  }
}

const queueTrack = {
  position: 0,
  isrc: 'JPTEST000001',
  spotify_id: 'spotify-1',
  stationhead_track_id: 101,
  duration_ms: 180_000,
};

test('track resolution prefers metadata already stored in MINUTE_DB', async () => {
  const minuteDb = new FakeDb([{
    spotify_id: 'spotify-1',
    title: 'Minute title',
    artist: 'Minute artist',
  }]);
  const buddiesDb = new FakeDb([{
    spotify_id: 'spotify-1',
    title: 'Legacy title',
    artist: 'Legacy artist',
  }]);

  const [resolved] = await resolveTracksBulk(minuteDb, buddiesDb, [queueTrack], 1_000);

  assert.equal(resolved.title, 'Minute title');
  assert.equal(resolved.artist, 'Minute artist');
  assert.equal(minuteDb.metadataQueries, 1);
  assert.equal(buddiesDb.metadataQueries, 0);
});

test('track resolution fills incomplete MINUTE metadata from the legacy source', async () => {
  const minuteDb = new FakeDb([{
    spotify_id: 'spotify-1',
    title: 'Minute title',
    artist: null,
  }]);
  const buddiesDb = new FakeDb([{
    spotify_id: 'spotify-1',
    title: 'Legacy title',
    artist: 'Legacy artist',
  }]);

  const [resolved] = await resolveTracksBulk(minuteDb, buddiesDb, [queueTrack], 1_000);

  assert.equal(resolved.title, 'Minute title');
  assert.equal(resolved.artist, 'Legacy artist');
  assert.equal(minuteDb.metadataQueries, 1);
  assert.equal(buddiesDb.metadataQueries, 1);
});

test('track metadata migration creates both Spotify and ISRC repair paths', () => {
  const migration = readFileSync(
    new URL('../../database/facts-migrations/014_backfill_track_metadata.sql', import.meta.url),
    'utf8',
  );
  const isrcMigration = readFileSync(
    new URL('../../database/facts-migrations/016_track_metadata_isrc.sql', import.meta.url),
    'utf8',
  );
  const provision = readFileSync(new URL('../scripts/provision-facts-db.mjs', import.meta.url), 'utf8');
  const metadata = JSON.parse(readFileSync(
    new URL('../../database/facts-db.json', import.meta.url),
    'utf8',
  ));

  assert.match(migration, /CREATE TABLE IF NOT EXISTS sh_isrc_metadata/);
  assert.match(migration, /UPDATE sh_tracks/);
  assert.match(migration, /FROM sh_track_metadata/);
  assert.match(migration, /FROM sh_isrc_metadata/);
  assert.match(isrcMigration, /ALTER TABLE sh_track_metadata ADD COLUMN isrc TEXT/);
  assert.match(isrcMigration, /idx_sh_track_metadata_isrc/);
  assert.match(provision, /014_backfill_track_metadata\.sql/);
  assert.equal(metadata.schema, 'database/facts-migrations/016_track_metadata_isrc.sql');
});
