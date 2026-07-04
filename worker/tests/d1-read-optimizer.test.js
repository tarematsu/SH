import test from 'node:test';
import assert from 'node:assert/strict';

import { rewriteDuplicateVelocityRead, withDuplicateVelocityReadRemoved } from '../src/d1-read-optimizer.js';

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

function fakeDb() {
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
      return null;
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

test('DB proxy rewrites only scheduled snapshot prepare calls', () => {
  const db = fakeDb();
  const env = withDuplicateVelocityReadRemoved({ DB: db, CHAT_LIMIT: 50 });
  env.DB.prepare(SNAPSHOT_SQL);
  env.DB.prepare('SELECT 1');
  assert.equal(db.calls.length, 0);
});

test('identical collector heartbeats skip D1 for ten minutes', async () => {
  const db = fakeDb();
  let now = 1_000;
  const env = withDuplicateVelocityReadRemoved({ DB: db, CHAT_LIMIT: 50 }, () => now);
  const runHeartbeat = () => env.DB.prepare(HEARTBEAT_SQL)
    .bind('worker', now, now, 'cloudflare-workers', '1.0.0', '{"source":"scheduled"}')
    .run();

  const first = await runHeartbeat();
  now += 60_000;
  const second = await runHeartbeat();

  assert.equal(first.meta.changes, 1);
  assert.equal(second.meta.changes, 0);
  assert.equal(second.meta.skip_reason, 'heartbeat-cadence');
  assert.equal(db.calls.filter((call) => call.type === 'run').length, 1);

  now += 10 * 60_000;
  await runHeartbeat();
  assert.equal(db.calls.filter((call) => call.type === 'run').length, 2);
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
});

test('repeated failure-state clears skip D1 until a new failure is written', async () => {
  const db = fakeDb();
  let now = 1_000;
  const env = withDuplicateVelocityReadRemoved({ DB: db }, () => now);

  await env.DB.prepare(CLEAR_SQL).bind('stationhead').run();
  now += 60_000;
  const skipped = await env.DB.prepare(CLEAR_SQL).bind('stationhead').run();
  assert.equal(skipped.meta.skip_reason, 'failure-already-clear');
  assert.equal(db.calls.filter((call) => call.type === 'run').length, 1);

  await env.DB.prepare(FAILURE_SQL)
    .bind('stationhead', now, now, 'CODE', 'stage', 'summary', null, null, 'worker', now)
    .run();
  await env.DB.prepare(CLEAR_SQL).bind('stationhead').run();
  assert.equal(db.calls.filter((call) => call.type === 'run').length, 3);
});

test('batch unwraps optimized prepared statements', async () => {
  const db = fakeDb();
  const env = withDuplicateVelocityReadRemoved({ DB: db });
  const statement = env.DB.prepare('SELECT 1');
  await env.DB.batch([statement]);
  assert.equal(db.calls[0].type, 'batch');
  assert.equal(db.calls[0].statements.length, 1);
});
