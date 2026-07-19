import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  appleMusicFreeD1,
  withoutAppleMusicHotPathSql,
} from '../../site/functions/lib/apple-music-d1-pruner.js';

const revisionSql = `SELECT json_extract(track.value,'$.spotify_id') AS spotify_id,
  json_extract(track.value,'$.apple_music_id') AS apple_music_id,
  json_extract(track.value,'$.isrc') AS isrc FROM json_each(?) track`;
const updateSql = `UPDATE sh_queue_items SET
  spotify_id=excluded.spotify_id,apple_music_id=NULL,
  isrc=excluded.isrc WHERE id=?`;

test('hot-path SQL removes unused Apple extraction and null assignments without changing binds', () => {
  const revision = withoutAppleMusicHotPathSql(revisionSql);
  const update = withoutAppleMusicHotPathSql(updateSql);
  assert.doesNotMatch(revision, /apple_music_id/i);
  assert.doesNotMatch(update, /apple_music_id/i);
  assert.equal((revision.match(/\?/g) || []).length, 1);
  assert.equal((update.match(/\?/g) || []).length, 1);
  assert.match(revision, /spotify_id/);
  assert.match(revision, /isrc/);
});

test('D1 adapter prepares pruned SQL and preserves database methods', () => {
  let preparedSql = null;
  const db = {
    prepare(sql) {
      preparedSql = sql;
      return { sql };
    },
    marker() { return 11; },
  };
  const wrapped = appleMusicFreeD1(db);
  assert.equal(wrapped.prepare(updateSql).sql, withoutAppleMusicHotPathSql(updateSql));
  assert.equal(preparedSql, withoutAppleMusicHotPathSql(updateSql));
  assert.equal(wrapped.marker(), 11);
  assert.equal(appleMusicFreeD1(db), wrapped);
});

test('production ingest, persistence and minute derive install the SQL adapter', () => {
  const ingest = readFileSync(new URL('../../site/functions/api/ingest.js', import.meta.url), 'utf8');
  const persist = readFileSync(new URL('../src/persist-channel-optimized-entry.js', import.meta.url), 'utf8');
  const derive = readFileSync(new URL('../src/minute-derive-entry.js', import.meta.url), 'utf8');
  assert.match(ingest, /withAppleMusicFreeD1\(env\)/);
  assert.match(persist, /withAppleMusicFreeD1\(env\)/);
  assert.match(derive, /withMinuteD1WriteThrottling\(withAppleMusicFreeD1\(env\)\)/);
});
