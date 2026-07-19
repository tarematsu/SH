import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resetMinuteD1WriteRewriteCacheForTests,
  withMinuteD1WriteThrottling,
} from '../src/minute-d1-write-throttle.js';

const REVISION_SOURCE_SQL = `SELECT id,status,effective_at,item_count,materialized_item_count,
    coverage_complete,source_job_id,source_visible_count
  FROM sh_queue_revisions
  WHERE channel_id=? AND structural_hash=? AND session_id IS ? AND queue_start_time IS ?
    AND status IN ('complete','pending')
  ORDER BY CASE status WHEN 'complete' THEN 0 ELSE 1 END,effective_at DESC,id DESC
  LIMIT 1`;

const REVISION_COUNT_SQL = 'SELECT COUNT(*) AS item_count FROM sh_queue_revision_items WHERE revision_id=?';

const REVISION_ITEM_SQL = `INSERT INTO sh_queue_revision_items(
    revision_id,position,track_id
  ) VALUES(?,?,?) ON CONFLICT(revision_id,position) DO UPDATE SET track_id=excluded.track_id`;

class Statement {
  constructor(db, sql, binds = []) {
    this.db = db;
    this.sql = sql;
    this.binds = binds;
  }

  bind(...binds) {
    return new Statement(this.db, this.sql, binds);
  }

  async first() {
    if (this.sql.includes('FROM sh_queue_revisions')) {
      this.db.sourceReads += 1;
      return this.db.sourceRows.shift() || null;
    }
    if (this.sql === REVISION_COUNT_SQL) {
      this.db.countReads += 1;
      return { item_count: this.db.countValue };
    }
    throw new Error(`unexpected first SQL: ${this.sql}`);
  }

  async run() {
    this.db.runs.push({ sql: this.sql, binds: this.binds });
    return { success: true, meta: { changes: 1 } };
  }
}

class FakeDb {
  constructor() {
    this.sourceRows = [];
    this.sourceReads = 0;
    this.countReads = 0;
    this.countValue = 0;
    this.runs = [];
    this.batches = [];
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    this.batches.push(statements.map((statement) => ({ sql: statement.sql, binds: statement.binds })));
    return statements.map(() => ({ success: true, meta: { changes: 1 } }));
  }
}

async function loadRevisionAndCount(active, revisionId = 60) {
  const revision = await active.MINUTE_DB.prepare(REVISION_SOURCE_SQL)
    .bind(10, 'hash', null, 1000)
    .first();
  const count = await active.MINUTE_DB.prepare(REVISION_COUNT_SQL)
    .bind(revisionId)
    .first();
  return { revision, count };
}

test('verified complete revision progress skips the duplicate count query', async () => {
  const db = new FakeDb();
  db.sourceRows.push({
    id: 60,
    status: 'complete',
    item_count: 6,
    materialized_item_count: 6,
    coverage_complete: 1,
  });
  db.countValue = 99;
  const active = withMinuteD1WriteThrottling({ MINUTE_DB: db });

  const { count } = await loadRevisionAndCount(active);

  assert.deepEqual(count, {
    item_count: 6,
    cached_revision_progress: true,
  });
  assert.equal(db.sourceReads, 1);
  assert.equal(db.countReads, 0);
  resetMinuteD1WriteRewriteCacheForTests(db);
});

test('pending and incomplete revisions still execute the authoritative count', async () => {
  const db = new FakeDb();
  db.sourceRows.push({
    id: 60,
    status: 'pending',
    item_count: 6,
    materialized_item_count: 5,
    coverage_complete: 0,
  });
  db.countValue = 6;
  const active = withMinuteD1WriteThrottling({ MINUTE_DB: db });

  const { count } = await loadRevisionAndCount(active);

  assert.deepEqual(count, { item_count: 6 });
  assert.equal(db.countReads, 1);
  resetMinuteD1WriteRewriteCacheForTests(db);
});

test('revision item writes invalidate cached complete progress', async () => {
  const db = new FakeDb();
  db.sourceRows.push({
    id: 60,
    status: 'complete',
    item_count: 6,
    materialized_item_count: 6,
    coverage_complete: 1,
  });
  db.countValue = 7;
  const active = withMinuteD1WriteThrottling({ MINUTE_DB: db });

  await active.MINUTE_DB.prepare(REVISION_SOURCE_SQL)
    .bind(10, 'hash', null, 1000)
    .first();
  const item = active.MINUTE_DB.prepare(REVISION_ITEM_SQL).bind(60, 6, 100);
  await active.MINUTE_DB.batch([item]);
  const count = await active.MINUTE_DB.prepare(REVISION_COUNT_SQL).bind(60).first();

  assert.deepEqual(count, { item_count: 7 });
  assert.equal(db.countReads, 1);
  assert.deepEqual(db.batches[0][0].binds, [60, 6, 100]);
  resetMinuteD1WriteRewriteCacheForTests(db);
});

test('null or invalid stored progress is never cached', async () => {
  const db = new FakeDb();
  db.sourceRows.push({
    id: 60,
    status: 'complete',
    item_count: 6,
    materialized_item_count: null,
    coverage_complete: 1,
  });
  db.countValue = 6;
  const active = withMinuteD1WriteThrottling({ MINUTE_DB: db });

  const { count } = await loadRevisionAndCount(active);

  assert.deepEqual(count, { item_count: 6 });
  assert.equal(db.countReads, 1);
  resetMinuteD1WriteRewriteCacheForTests(db);
});
