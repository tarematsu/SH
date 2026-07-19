import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  rewriteBackfillCursorBinds,
  rewriteBackfillCursorSql,
  withBackfillCursorSeek,
} from '../src/backfill-cursor-seek.js';

const SOURCE_SQL = `SELECT id,observed_at
  FROM sh_channel_snapshots
  WHERE observed_at<? AND (
      observed_at>? OR (observed_at=? AND id>?)
    )
    ORDER BY observed_at ASC,id ASC LIMIT ?`;

test('backfill cursor scan becomes a composite range seek with reordered binds', () => {
  const rewritten = rewriteBackfillCursorSql(SOURCE_SQL);
  assert.match(rewritten, /WHERE \(observed_at,id\)>\(\?,\?\)/);
  assert.match(rewritten, /AND observed_at<\?/);
  assert.doesNotMatch(rewritten, /observed_at>\? OR/);
  assert.deepEqual(rewriteBackfillCursorBinds([100, 10, 10, 1, 20]), [10, 1, 100, 20]);
});

test('the rewritten query uses the existing observed_at and id index', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sh_channel_snapshots(id INTEGER PRIMARY KEY,observed_at INTEGER NOT NULL);
    CREATE INDEX idx_sh_channel_snapshots_observed_id
      ON sh_channel_snapshots(observed_at,id);
    INSERT INTO sh_channel_snapshots(id,observed_at) VALUES(1,10),(2,10),(3,11),(4,101);`);
  const rewritten = rewriteBackfillCursorSql(SOURCE_SQL);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${rewritten}`).all(10, 1, 100, 20);
  assert.ok(plan.some((row) => /SEARCH sh_channel_snapshots USING COVERING INDEX idx_sh_channel_snapshots_observed_id/.test(row.detail)));
  assert.deepEqual(db.prepare(rewritten).all(10, 1, 100, 20).map((row) => row.id), [2, 3]);
});

test('production wrapper changes only the matching BUDDIES_DB statement', async () => {
  const prepared = [];
  const bound = [];
  const db = {
    prepare(sql) {
      prepared.push(sql);
      return {
        bind(...values) {
          bound.push(values);
          return { all: async () => ({ results: [] }) };
        },
      };
    },
  };
  const env = withBackfillCursorSeek({ BUDDIES_DB: db, marker: 1 });
  await env.BUDDIES_DB.prepare(SOURCE_SQL).bind(100, 10, 10, 1, 20).all();
  assert.match(prepared[0], /\(observed_at,id\)>\(\?,\?\)/);
  assert.deepEqual(bound[0], [10, 1, 100, 20]);
  assert.equal(env.marker, 1);
});

test('inconsistent legacy cursor binds fail closed', () => {
  assert.throws(
    () => rewriteBackfillCursorBinds([100, 10, 11, 1, 20]),
    /cursor bind pair is inconsistent/,
  );
});
