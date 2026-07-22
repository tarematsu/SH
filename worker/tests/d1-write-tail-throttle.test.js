import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  resetMinuteD1WriteRewriteCacheForTests,
  rewriteHistoricalSessionSeekSql,
  rewriteMinuteD1WriteSql,
  withMinuteD1WriteThrottling,
} from '../src/minute-d1-write-throttle.js';

const TRACK_UPDATE = `UPDATE sh_tracks SET
  isrc=COALESCE(isrc,?),spotify_id=COALESCE(spotify_id,?),
  stationhead_track_id=COALESCE(stationhead_track_id,?),
  title=COALESCE(title,?),artist=COALESCE(artist,?),last_seen_at=MAX(last_seen_at,?)
WHERE id=?`;

const TRACK_ALIAS = `INSERT INTO sh_track_aliases(
  alias_type,alias_value,track_id,first_seen_at,last_seen_at
) VALUES(?,?,?,?,?) ON CONFLICT(alias_type,alias_value) DO UPDATE SET
  last_seen_at=MAX(sh_track_aliases.last_seen_at,excluded.last_seen_at)`;

const HOST_ALIAS = TRACK_ALIAS
  .replaceAll('sh_track_aliases', 'sh_host_aliases')
  .replace('track_id', 'host_id');

const HISTORICAL_SESSION = `SELECT id FROM sh_broadcast_sessions
  WHERE channel_id=? AND broadcast_start_time=?
  ORDER BY ABS(first_observed_at-?) ASC,id ASC LIMIT 1`;

test('track identity updates fill missing values immediately and checkpoint last_seen every twenty minutes', () => {
  resetMinuteD1WriteRewriteCacheForTests();
  const sql = rewriteMinuteD1WriteSql(TRACK_UPDATE);
  assert.match(sql, /isrc=COALESCE\(isrc,\?1\)/);
  assert.match(sql, /\?6-COALESCE\(last_seen_at,0\)>=1200000/);
  assert.match(sql, /\(\?4 IS NOT NULL AND title IS NULL\)/);
  assert.equal((sql.match(/\?7/g) || []).length, 1);

  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sh_tracks(
      id INTEGER PRIMARY KEY,isrc TEXT,spotify_id TEXT,stationhead_track_id INTEGER,
      title TEXT,artist TEXT,last_seen_at INTEGER NOT NULL
    );
    INSERT INTO sh_tracks VALUES
      (1,NULL,NULL,NULL,'Song','Artist',0),
      (2,NULL,NULL,NULL,NULL,'Artist',1200000);`);
  const update = db.prepare(sql);
  assert.equal(update.run(null, null, null, null, null, 1199999, 1).changes, 0);
  assert.equal(update.run(null, null, null, null, null, 1200000, 1).changes, 1);
  assert.equal(update.run(null, null, null, 'Recovered title', null, 1200001, 2).changes, 1);
  assert.equal(db.prepare('SELECT title FROM sh_tracks WHERE id=2').get().title, 'Recovered title');
});

test('track and host aliases checkpoint timestamp-only conflict updates every twenty minutes', () => {
  const track = rewriteMinuteD1WriteSql(TRACK_ALIAS);
  const host = rewriteMinuteD1WriteSql(HOST_ALIAS);
  assert.match(track, /excluded\.last_seen_at-COALESCE\(sh_track_aliases\.last_seen_at,0\)>=1200000/);
  assert.match(host, /excluded\.last_seen_at-COALESCE\(sh_host_aliases\.last_seen_at,0\)>=1200000/);
  assert.equal(rewriteMinuteD1WriteSql(track), track);

  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sh_track_aliases(
      alias_type TEXT NOT NULL,alias_value TEXT NOT NULL,track_id INTEGER NOT NULL,
      first_seen_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,
      PRIMARY KEY(alias_type,alias_value)
    );
    INSERT INTO sh_track_aliases VALUES('isrc','A',1,0,0);`);
  const upsert = db.prepare(track);
  assert.equal(upsert.run('isrc', 'A', 1, 0, 1199999).changes, 0);
  assert.equal(upsert.run('isrc', 'A', 1, 0, 1200000).changes, 1);
  assert.equal(
    db.prepare("SELECT last_seen_at FROM sh_track_aliases WHERE alias_type='isrc' AND alias_value='A'").get().last_seen_at,
    1200000,
  );
});

test('historical session lookup probes one row on each side of the observation', () => {
  const sql = rewriteHistoricalSessionSeekSql(HISTORICAL_SESSION);
  assert.match(sql, /before_match/);
  assert.match(sql, /after_match/);
  assert.match(sql, /first_observed_at<=\?3/);
  assert.match(sql, /first_observed_at>\?3/);
  assert.doesNotMatch(sql, /FROM sh_broadcast_sessions[\s\S]*ORDER BY ABS\(first_observed_at-\?\)/);

  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sh_broadcast_sessions(
      id INTEGER PRIMARY KEY,channel_id INTEGER,broadcast_start_time INTEGER,first_observed_at INTEGER
    );
    CREATE INDEX idx_sh_broadcast_sessions_channel_start
      ON sh_broadcast_sessions(channel_id,broadcast_start_time,first_observed_at,id);
    INSERT INTO sh_broadcast_sessions VALUES
      (1,7,100,120),(2,7,100,150),(3,7,100,190),(4,8,100,151);`);
  assert.equal(db.prepare(sql).get(7, 100, 166).id, 2);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(7, 100, 166);
  const searches = plan.filter((row) => /SEARCH sh_broadcast_sessions USING COVERING INDEX idx_sh_broadcast_sessions_channel_start/.test(row.detail));
  assert.equal(searches.length, 2);
});

test('wrapped batches pass original bound statements to D1', async () => {
  const prepared = [];
  const batches = [];
  const db = {
    prepare(sql) {
      prepared.push(sql);
      return {
        sql,
        bind(...binds) { return { sql, binds }; },
      };
    },
    async batch(statements) {
      batches.push(statements);
      return [];
    },
  };
  const active = withMinuteD1WriteThrottling({ MINUTE_DB: db });
  const statement = active.MINUTE_DB.prepare(TRACK_ALIAS).bind('isrc', 'A', 1, 1, 1);
  await active.MINUTE_DB.batch([statement]);
  assert.match(prepared[0], /excluded\.last_seen_at-COALESCE/);
  assert.deepEqual(batches[0][0].binds, ['isrc', 'A', 1, 1, 1]);
});

test('wrapped session lookup retains its original three binds', async () => {
  const prepared = [];
  const binds = [];
  const db = {
    prepare(sql) {
      prepared.push(sql);
      return {
        bind(...values) {
          binds.push(values);
          return { first: async () => ({ id: 9 }) };
        },
      };
    },
  };
  const active = withMinuteD1WriteThrottling({ MINUTE_DB: db });
  const row = await active.MINUTE_DB.prepare(HISTORICAL_SESSION).bind(7, 100, 166).first();
  assert.equal(row.id, 9);
  assert.match(prepared[0], /before_match/);
  assert.deepEqual(binds[0], [7, 100, 166]);
});

test('rebuild runtime diagnostics checkpoint only unchanged successful state', () => {
  const source = readFileSync(new URL('../src/minute-facts-runtime-state.js', import.meta.url), 'utf8');
  assert.match(source, /RUNTIME_SUCCESS_CHECKPOINT_MS = 5 \* 60_000/);
  assert.match(source, /WHERE excluded\.task_name NOT IN \('rebuild','derive'\)/);
  assert.match(source, /OR excluded\.failed_total>0/);
  assert.match(source, /pending_count IS NOT excluded\.pending_count/);
  assert.match(source, /excluded\.updated_at-COALESCE\(sh_minute_fact_runtime_state\.updated_at,0\)>=\$\{RUNTIME_SUCCESS_CHECKPOINT_MS\}/);
});

test('production derive and enrichment entrypoints install only the D1 write throttle', () => {
  const derive = readFileSync(new URL('../src/minute-derive-entry.js', import.meta.url), 'utf8');
  const enrichment = readFileSync(new URL('../src/minute-enrichment-optimized-entry.js', import.meta.url), 'utf8');
  assert.match(derive, /withMinuteD1WriteThrottling\(env\)/);
  assert.match(enrichment, /withMinuteD1WriteThrottling\(env\)/);
  assert.doesNotMatch(derive, /AppleMusic|apple-music|withAppleMusic/i);
  assert.doesNotMatch(enrichment, /AppleMusic|apple-music|withAppleMusic/i);
});
