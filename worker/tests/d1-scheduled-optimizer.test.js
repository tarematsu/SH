import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_CLEANUP_BACKOFF_MS,
  MAINTENANCE_CADENCE_MS,
  OFFICIAL_NEWS_CLAIM_SQL,
  OFFICIAL_NEWS_FAILURE_SQL,
  scheduledStatementKind,
  withScheduledD1Optimizations
} from '../src/d1-scheduled-optimizer.js';

class FakeStatement {
  constructor(db, sql, binds = []) {
    this.db = db;
    this.sql = sql;
    this.binds = binds;
  }

  bind(...binds) {
    return new FakeStatement(this.db, this.sql, binds);
  }

  first() {
    return this.db.first(this.sql, this.binds);
  }

  run() {
    return this.db.run(this.sql, this.binds);
  }
}

class FakeDb {
  constructor() {
    this.claimResult = { last_success_at: 5_000, last_error: null };
    this.runCalls = [];
    this.batchChanges = [0, 0, 0, 0];
    this.runErrorMatcher = null;
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async first(sql) {
    if (sql === OFFICIAL_NEWS_CLAIM_SQL) return this.claimResult;
    return null;
  }

  async run(sql, binds) {
    this.runCalls.push({ sql, binds });
    if (this.runErrorMatcher?.(sql, binds)) throw new Error('missed announcement update failed');
    return { success: true, meta: { changes: 1 } };
  }

  async batch(statements) {
    return statements.map((statement, index) => ({
      success: true,
      meta: { changes: this.batchChanges[index] || 0 },
      statement
    }));
  }
}

const OFFICIAL_READ_SQL = `SELECT last_check_at,last_success_at,last_error
  FROM sh_official_news_monitor_state WHERE id=?`;
const OFFICIAL_WRITE_SQL = `INSERT INTO sh_official_news_monitor_state
  (id,last_check_at,last_success_at,last_error,updated_at)
  VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_check_at=excluded.last_check_at`;
const OFFICIAL_MISSED_SQL = `UPDATE sh_official_news_announcements SET status='missed',updated_at=?
  WHERE status='scheduled' AND scheduled_at IS NOT NULL AND scheduled_at<?`;
const MAINTENANCE_FINAL_SQL = `INSERT INTO sh_data_maintenance_state(
  id,last_rollup_key,last_cleanup_at,legacy_backfill_id,updated_at
) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
  last_rollup_key=CASE WHEN 1 THEN excluded.last_rollup_key END`;

test('official news state read is replaced by an atomic conditional claim', () => {
  assert.equal(scheduledStatementKind(OFFICIAL_READ_SQL), 'official-news-state-read');
  assert.match(OFFICIAL_NEWS_CLAIM_SQL, /ON CONFLICT\(id\) DO UPDATE/i);
  assert.match(OFFICIAL_NEWS_CLAIM_SQL, /WHERE COALESCE\(.+last_check_at,0\)<=\?/is);
  assert.match(OFFICIAL_NEWS_CLAIM_SQL, /RETURNING last_success_at,last_error/i);
});

test('successful official check skips the redundant post-claim start write', async () => {
  const db = new FakeDb();
  const env = withScheduledD1Optimizations({
    DB: db,
    OFFICIAL_NEWS_CHECK_INTERVAL_MS: 30 * 60_000
  }, () => 10_000);

  const state = await env.DB.prepare(OFFICIAL_READ_SQL).bind('official-news').first();
  assert.deepEqual(state, {
    last_check_at: 0,
    last_success_at: 5_000,
    last_error: null
  });

  const skipped = await env.DB.prepare(OFFICIAL_WRITE_SQL)
    .bind('official-news', 9_999, 5_000, null, 9_999)
    .run();
  assert.equal(skipped.meta.skipped_by_optimizer, true);
  assert.equal(db.runCalls.length, 0);

  await env.DB.prepare(OFFICIAL_WRITE_SQL)
    .bind('official-news', 9_999, 9_999, null, 9_999)
    .run();
  assert.equal(db.runCalls.length, 1);
});

test('missed-announcement cleanup failure is persisted against the held claim', async () => {
  const db = new FakeDb();
  db.runErrorMatcher = (sql) => sql === OFFICIAL_MISSED_SQL;
  const env = withScheduledD1Optimizations({
    DB: db,
    OFFICIAL_NEWS_CHECK_INTERVAL_MS: 30 * 60_000
  }, () => 10_000);

  await env.DB.prepare(OFFICIAL_READ_SQL).bind('official-news').first();
  await assert.rejects(
    env.DB.prepare(OFFICIAL_MISSED_SQL).bind(10_000, -5_000).run(),
    /missed announcement update failed/
  );

  assert.equal(db.runCalls.length, 2);
  assert.equal(db.runCalls[0].sql, OFFICIAL_MISSED_SQL);
  assert.equal(db.runCalls[1].sql, OFFICIAL_NEWS_FAILURE_SQL);
  assert.deepEqual(db.runCalls[1].binds, [
    'official-news',
    10_000,
    5_000,
    'missed announcement update failed',
    10_000
  ]);
});

test('empty retention cleanup persists a six-hour cleanup interval', async () => {
  const now = 20_000;
  const db = new FakeDb();
  const env = withScheduledD1Optimizations({ DB: db }, () => now);
  const tables = [
    'sh_channel_snapshots',
    'sh_raw_events',
    'sh_realtime_metrics',
    'sh_queue_snapshots'
  ];
  const cleanup = tables.map((table) => env.DB.prepare(
    `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE observed_at<? LIMIT ?)`
  ).bind(0, 5_000));

  await env.DB.batch(cleanup);
  await env.DB.prepare(MAINTENANCE_FINAL_SQL)
    .bind('rollup-retention-v1', null, now, 0, now)
    .run();

  const marker = db.runCalls.at(-1).binds[2];
  assert.equal(marker, now + EMPTY_CLEANUP_BACKOFF_MS - MAINTENANCE_CADENCE_MS);
  assert.equal(marker + MAINTENANCE_CADENCE_MS, now + EMPTY_CLEANUP_BACKOFF_MS);
});

test('retention cleanup statements and final state write are classified', () => {
  assert.equal(
    scheduledStatementKind(`DELETE FROM sh_channel_snapshots WHERE id IN (
      SELECT id FROM sh_channel_snapshots WHERE observed_at<? LIMIT ?
    )`),
    'retention-cleanup'
  );
  assert.equal(scheduledStatementKind(OFFICIAL_MISSED_SQL), 'official-news-expiry-write');
  assert.equal(scheduledStatementKind(MAINTENANCE_FINAL_SQL), 'maintenance-final-state');
  assert.equal(EMPTY_CLEANUP_BACKOFF_MS, 6 * 60 * 60_000);
});
