import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  appleMusicFreeD1,
  appleMusicStatementPlan,
  withoutAppleMusicHotPathSql,
} from '../../site/functions/lib/apple-music-d1-pruner.js';

const revisionSql = `SELECT json_extract(track.value,'$.spotify_id') AS spotify_id,
  json_extract(track.value,'$.apple_music_id') AS apple_music_id,
  json_extract(track.value,'$.isrc') AS isrc FROM json_each(?) track`;
const updateSql = `UPDATE sh_queue_items SET
  spotify_id=excluded.spotify_id,apple_music_id=NULL,
  isrc=excluded.isrc WHERE id=?`;
const currentBiteSql = `INSERT OR IGNORE INTO sh_track_counter_changes(
  observed_at,occurrence_key,channel_id,station_id,queue_id,queue_start_time,
  queue_position,queue_track_id,stationhead_track_id,spotify_id,apple_music_id,isrc,
  queue_revision_id,track_id,track_key,count_value,source,source_record_id
) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
WHERE ? IS NOT (SELECT count_value FROM sh_track_counter_changes WHERE occurrence_key=?)`;

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

test('current bite insert removes the Apple column and matching bind only', () => {
  const plan = appleMusicStatementPlan(currentBiteSql);
  assert.doesNotMatch(plan.sql, /apple_music_id/i);
  assert.equal(plan.dropBindIndex, 10);
  assert.equal((plan.sql.match(/\?/g) || []).length, 19);

  let preparedSql = null;
  let bound = null;
  const db = {
    prepare(sql) {
      preparedSql = sql;
      return {
        bind(...values) {
          bound = values;
          return { values };
        },
      };
    },
  };
  const values = Array.from({ length: 20 }, (_value, index) => `v${index + 1}`);
  appleMusicFreeD1(db).prepare(currentBiteSql).bind(...values);
  assert.equal(preparedSql, plan.sql);
  assert.deepEqual(bound, values.filter((_value, index) => index !== 10));
  assert.equal(bound[9], 'v10');
  assert.equal(bound[10], 'v12');
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

test('production ingest, persistence, derive and enrichment install the adapter', () => {
  const ingest = readFileSync(new URL('../../site/functions/api/ingest.js', import.meta.url), 'utf8');
  const persist = readFileSync(new URL('../src/persist-channel-optimized-entry.js', import.meta.url), 'utf8');
  const derive = readFileSync(new URL('../src/minute-derive-entry.js', import.meta.url), 'utf8');
  const enrichment = readFileSync(new URL('../src/minute-enrichment-optimized-entry.js', import.meta.url), 'utf8');
  assert.match(ingest, /withAppleMusicFreeD1\(env\)/);
  assert.match(persist, /withAppleMusicFreeD1\(env\)/);
  assert.match(derive, /withMinuteD1WriteThrottling\(withAppleMusicFreeD1\(env\)\)/);
  assert.match(enrichment, /withMinuteD1WriteThrottling\(withAppleMusicFreeD1\(env\)\)/);
  assert.match(enrichment, /stripAppleMusicFields\(body\)/);
});
