import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resetD1OptimizerState,
  withDuplicateVelocityReadRemoved,
} from '../src/d1-read-optimizer.js';

const STATE_WRITE_SQL = `INSERT INTO sh_worker_collector_state (
  id, auth_token, device_uid, token_expires_at, last_run_at, last_success_at,
  last_error, last_channel_id, last_station_id, updated_at
) VALUES ('stationhead', ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  auth_token=excluded.auth_token,
  device_uid=excluded.device_uid,
  token_expires_at=excluded.token_expires_at,
  last_run_at=excluded.last_run_at,
  last_success_at=excluded.last_success_at,
  last_error=excluded.last_error,
  last_channel_id=excluded.last_channel_id,
  last_station_id=excluded.last_station_id,
  updated_at=excluded.updated_at`;

const LEASE_HEALTH_SQL = `SELECT last_success_at,last_error
  FROM sh_worker_collector_state WHERE id='stationhead'`;

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = String(sql);
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async run() {
    this.db.runs.push({ sql: this.sql, params: [...this.params] });
    return { success: true, meta: { changes: 1 } };
  }

  async first() {
    this.db.reads.push({ sql: this.sql, params: [...this.params] });
    return { last_success_at: 1_000, last_error: 'stale database value' };
  }
}

class RecordingDb {
  constructor() {
    this.runs = [];
    this.reads = [];
  }

  prepare(sql) {
    return new Statement(this, sql);
  }
}

function stateParams(lastRunAt, lastSuccessAt, lastError = null) {
  return [
    'token',
    'device',
    9_999_999,
    lastRunAt,
    lastSuccessAt,
    lastError,
    10,
    20,
    lastSuccessAt,
  ];
}

test('lease health reads use the fresh state even when the D1 checkpoint write is skipped', async () => {
  let now = 10_000;
  const db = new RecordingDb();
  resetD1OptimizerState(db);
  const env = withDuplicateVelocityReadRemoved({ DB: db }, () => now);

  await env.DB.prepare(STATE_WRITE_SQL).bind(...stateParams(10_000, 10_100)).run();
  assert.equal(db.runs.length, 1);

  now += 60_000;
  const skipped = await env.DB.prepare(STATE_WRITE_SQL)
    .bind(...stateParams(70_000, 70_100))
    .run();
  assert.equal(skipped.meta.skipped_by_optimizer, true);
  assert.equal(skipped.meta.skip_reason, 'collector-state-checkpoint');
  assert.equal(db.runs.length, 1);

  const health = await env.DB.prepare(LEASE_HEALTH_SQL).first();
  assert.deepEqual(health, { last_success_at: 70_100, last_error: null });
  assert.equal(db.reads.length, 0);
});

test('cached failure state remains visible to lease health checks', async () => {
  let now = 20_000;
  const db = new RecordingDb();
  resetD1OptimizerState(db);
  const env = withDuplicateVelocityReadRemoved({ DB: db }, () => now);

  await env.DB.prepare(STATE_WRITE_SQL).bind(...stateParams(20_000, 19_000)).run();
  now += 60_000;
  await env.DB.prepare(STATE_WRITE_SQL)
    .bind(...stateParams(80_000, 19_000, 'snapshot write failed'))
    .run();

  const health = await env.DB.prepare(LEASE_HEALTH_SQL).first();
  assert.deepEqual(health, {
    last_success_at: 19_000,
    last_error: 'snapshot write failed',
  });
  assert.equal(db.reads.length, 0);
});
