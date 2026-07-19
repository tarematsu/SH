import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  attachReadModelTrackMetadata,
  loadReadModelTrackMetadata,
} from '../src/minute-facts-read-model.js';

const migration = await readFile(
  new URL('../../database/facts-migrations/020_isrc_track_dictionary.sql', import.meta.url),
  'utf8',
);

test('ISRC dictionary migration materializes metadata but derives latest bite stats', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS sh_track_dictionary/);
  assert.match(migration, /isrc TEXT PRIMARY KEY/);
  assert.match(migration, /thumbnail_url TEXT/);
  assert.match(migration, /trg_sh_track_dictionary_metadata_insert/);
  assert.match(migration, /trg_sh_track_dictionary_isrc_metadata_insert/);
  assert.match(migration, /CREATE VIEW sh_track_stats_by_isrc/);
  assert.match(migration, /FROM sh_track_counter_current AS current/);
  assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS sh_track_stats_by_isrc/);
});

test('minute metadata hydration reads the ISRC dictionary before legacy metadata', async () => {
  let sql = '';
  let bindings = [];
  const MINUTE_DB = {
    prepare(statement) {
      sql = statement;
      return {
        bind(...values) {
          bindings = values;
          return this;
        },
        async all() {
          return {
            results: [{
              spotify_id: 'old-sp',
              isrc: 'USABC1234567',
              title: 'Song',
              artist: 'Artist',
              thumbnail_url: 'cover',
              fetched_at: 10,
            }],
          };
        },
      };
    },
  };

  const rows = await loadReadModelTrackMetadata(
    { MINUTE_DB },
    ['new-sp'],
    ['USABC1234567'],
  );
  assert.match(sql, /FROM sh_track_dictionary/);
  assert.match(sql, /UNION ALL/);
  assert.deepEqual(bindings, ['USABC1234567', 'new-sp']);

  const hydrated = attachReadModelTrackMetadata({
    tracks: [{
      spotify_id: 'new-sp',
      isrc: 'US-ABC-12-34567',
      title: null,
      artist: null,
      thumbnail_url: null,
    }],
  }, rows);
  assert.equal(hydrated.tracks[0].title, 'Song');
  assert.equal(hydrated.tracks[0].thumbnail_url, 'cover');
});

test('minute metadata hydration falls back to the legacy table before migration deployment', async () => {
  const statements = [];
  const MINUTE_DB = {
    prepare(sql) {
      const call = statements.length;
      statements.push(sql);
      return {
        bind() { return this; },
        async all() {
          if (call === 0) throw new Error('no such table: sh_track_dictionary');
          return {
            results: [{
              spotify_id: 'sp1',
              isrc: 'USABC1234567',
              title: 'Legacy Song',
              artist: 'Legacy Artist',
              thumbnail_url: 'legacy-cover',
              fetched_at: 5,
            }],
          };
        },
      };
    },
  };

  const rows = await loadReadModelTrackMetadata(
    { MINUTE_DB },
    ['sp1'],
    ['USABC1234567'],
  );
  assert.equal(statements.length, 2);
  assert.match(statements[0], /sh_track_dictionary/);
  assert.doesNotMatch(statements[1], /sh_track_dictionary/);
  assert.equal(rows[0].title, 'Legacy Song');
});
