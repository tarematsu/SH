import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resetD1OptimizerState,
  rewriteDuplicateVelocityRead,
  withDuplicateVelocityReadRemoved,
} from '../src/d1-read-optimizer.js';

const SNAPSHOT_SQL = `INSERT INTO sh_channel_snapshots (comment_velocity) VALUES ((
      SELECT COALESCE(SUM(comment_count),0) FROM sh_comment_minute_counts
      WHERE station_id=? AND bucket_start>=? AND bucket_start<=?
    ))`;
const HEARTBEAT_SQL = `INSERT INTO sh_collector_heartbeats (
  collector_id,first_seen_at,last_seen_at,hostname,version,metadata_json
) VALUES (?,?,?,?,?,?) ON CONFLICT(collector_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`;
const CLEAR_SQL = 'DELETE FROM sh_collector_failure_state WHERE id=?';
const FAILURE_SQL = `INSERT INTO sh_collector_failure_state (
  id,first_failure_at,last_failure_at,code,stage,summary,detail,hint,source,
  consecutive_failures,updated_at
) VALUES (?,?,?,?,?,?,?,?,?,1,?)`;
const STATE_READ_SQL = `SELECT auth_token, device_uid, token_expires_at, last_run_at, last_success_at,
       last_error, last_channel_id, last_station_id, updated_at
FROM sh_worker_collector_state
WHERE id = 'stationhead'`;
const STATE_WRITE_SQL = `INSERT INTO sh_worker_collector_state (
  id, auth_token, device_uid, token_expires_at, last_run_at, last_success_at,
  last_error, last_channel_id, last_station_id, updated_at
) VALUES ('stationhead', ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET auth_token=excluded.auth_token`;

function fakeDb(firstResult = null) {
  const calls = [];
  const makeStatement = (sql, binds = []) => ({
    bind(...args) {
      return makeStatement(sql, args);
    },
    async run() {
      calls.push({ type: 'run', sql, binds });
      return { success: true, meta: { changes: 1 } };
    },
    async first() {
      calls.push({ type: 'first', sql, binds });
      return typeof firstResult === 'function' ? firstResult(sql, binds) : firstResult;
    },
  });
  return {
    calls,
    prepare(sql) {
      return makeStatement(sql);
    },
    async batch(statements) {
      calls.push({ type: 'batch', statements });
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
}

test('snapshot velocity SUM is replaced when comments are collected later', () => {
  const rewritten = rewriteDuplicateVelocityRead(SNAPSHOT_SQL, true);
  assert.equal(rewritten.includes('sh_comment_minute_counts'), false);
  assert.equal(rewritten.includes('SELECT 0 FROM'), true);
  assert.equal((rewritten.match(/\?/g) || []).length, 3);
});

test('snapshot velocity SUM remains for chat-disabled paths', () => {
  assert.equal(rewriteDuplicateVelocityRead(SNAPSHOT_SQL, false), SNAPSHOT_SQL);
});

test('optimizer state survives a new env proxy for the same DB binding', async () => {
  const db = fakeDb();
  let now = 1_000;
  const firstEnv = withDuplicateVelocityReadRemoved({ DB: db }, () => now);
  await firstEnv.DB.prepare(HEARTBEAT_SQL)
    .bind('worker', now, now, 'host', '1.0.0', '{}').run();

  now += 60_000;
  const secondEnv = withDuplicateVelocityReadRemoved({ DB: db }, () => now);
  const skipped = await secondEnv.DB.prepare(HEARTBEAT_SQL)
    .bind('worker', now, now, 'host', '1.0.0', '{}').run();

  assert.equal(skipped.meta.skip_reason, 'heartbeat-cadence');
  assert.equal(db.calls.filter((call) => call.type === 'run').length, 1);
  resetD1OptimizerState(db);
});

test('heartbeat metadata changes bypass cadence suppression', async () => {
  const db = fakeDb();
  let now = 1_000;
  const env = withDuplicateVelocityReadRemoved({ DB: db }, () => now);
  await env.DB.prepare(HEARTBEAT_SQL)
    .bind('worker', now, now, 'host-a', '1.0.0', '{}').run();
  now += 60_000;
  await env.DB.prepare(HEARTBEAT_SQL)
    .bind('worker', now, now, 'host-b', '1.0.0', '{}').run();
  assert.equal(db.calls.filter((call) => call.type === 'run').length, 2);
  resetD1OptimizerState(db);
});

test('repeated failure-state clears skip D1 until a new failure is written', async () => {
  const db = fakeDb();
  let now = 1_000;
  const env = withDuplicateVelocityReadRemoved({ DB: db }, () => now);

  await env.DB.prepare(CLEAR_SQL).bind('stationhead').run();
  now += 60_000;
  const skipped = await withDuplicateVelocityReadRemoved({ DB: db }, () => now)
    .DB.prepare(CLEAR_SQL).bind('stationhead').run();
  assert.equal(skipped.meta.skip_reason, 'failure-already-clear');

  await env.DB.prepare(FAILURE_SQL)
    .bind('stationhead', now, now, 'CODE', 'stage', 'summary', null, null, 'worker', now)
    .run();
  await env.DB.prepare(CLEAR_SQL).bind('stationhead').run();
  assert.equal(db.calls.filter((call) => call.type === 'run').length, 3);
  resetD1OptimizerState(db);
});

test('collector state read is cached for five minutes across cron invocations', async () => {
  const row = {
    auth_token: 'token', device_uid: 'device', token_expires_at: 99,
    last_run_at: 10, last_success_at: 10, last_error: null,
    last_channel_id: 1, last_station_id: 2, updated_at: 10,
  };
  const db = fakeDb(row);
  let now = 1_000;
  const first = await withDuplicateVelocityReadRemoved({ DB: db }, () => now)
    .DB.prepare(STATE_READ_SQL).first();
  now += 60_000;
  const second = await withDuplicateVelocityReadRemoved({ DB: db }, () => now)
    .DB.prepare(STATE_READ_SQL).first();

  assert.deepEqual(second, first);
  assert.equal(db.calls.filter((call) => call.type === 'first').length, 1);
  resetD1OptimizerState(db);
});

test('collector state timestamps checkpoint every five minutes', async () => {
  const db = fakeDb();
  let now = 1_000;
  const write = (lastRun, lastSuccess, error = null) => withDuplicateVelocityReadRemoved({ DB: db }, () => now)
    .DB.prepare(STATE_WRITE_SQL)
    .bind('token', 'device', 99, lastRun, lastSuccess, error, 1, 2, now)
    .run();

  await write(1_000, 1_000);
  now += 60_000;
  const skipped = await write(61_000, 61_000);
  assert.equal(skipped.meta.skip_reason, 'collector-state-checkpoint');
  assert.equal(db.calls.filter((call) => call.type === 'run').length, 1);

  now += 5 * 60_000;
  await write(now, now);
  assert.equal(db.calls.filter((call) => call.type === 'run').length, 2);
  resetD1OptimizerState(db);
});

test('collector state error changes persist immediately', async () => {
  const db = fakeDb();
  let now = 1_000;
  const env = withDuplicateVelocityReadRemoved({ DB: db }, () => now);
  await env.DB.prepare(STATE_WRITE_SQL)
    .bind('token', 'device', 99, now, now, null, 1, 2, now).run();
  now += 60_000;
  await env.DB.prepare(STATE_WRITE_SQL)
    .bind('token', 'device', 99, now, null, 'failure', 1, 2, now).run();
  assert.equal(db.calls.filter((call) => call.type === 'run').length, 2);
  resetD1OptimizerState(db);
});

test('batch unwraps optimized prepared statements', async () => {
  const db = fakeDb();
  const env = withDuplicateVelocityReadRemoved({ DB: db });
  const statement = env.DB.prepare('SELECT 1');
  await env.DB.batch([statement]);
  assert.equal(db.calls[0].type, 'batch');
  assert.equal(db.calls[0].statements.length, 1);
  resetD1OptimizerState(db);
});
