import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUDDY_HEALTH_SCHEMA_SQL,
  recordBuddyFailure,
  recordBuddySuccess,
  resetBuddyHealthForTests,
} from '../src/buddy-health.js';

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  first() {
    return this.db.first(this.sql, this.params);
  }

  run() {
    return this.db.run(this.sql, this.params);
  }
}

class FakeDb {
  constructor() {
    this.row = null;
    this.calls = [];
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async first(sql, params) {
    this.calls.push({ kind: 'first', sql, params });
    if (sql.includes('sh_collector_status')) return this.row;
    return null;
  }

  async run(sql, params) {
    this.calls.push({ kind: 'run', sql, params });
    if (sql.includes('INSERT INTO sh_collector_status')) {
      this.row = {
        collector_id: params[0],
        status: params[1],
        last_attempt_at: params[2],
        last_success_at: params[3] ?? this.row?.last_success_at ?? null,
        last_error: params[4],
        failure_code: params[5],
        failure_stage: params[6],
        failure_summary: params[7],
        failure_hint: params[8],
        tracks: params[9] ?? this.row?.tracks ?? null,
        changed: params[10],
        updated_at: params[11],
      };
    }
    return { success: true, meta: { changes: 1 } };
  }
}

test('buddy health records success and creates its schema only once', async () => {
  resetBuddyHealthForTests();
  const db = new FakeDb();
  const env = { DB: db };

  await recordBuddySuccess(env, 'buddy46', { tracks: 4, changed: true }, 1000);
  await recordBuddySuccess(env, 'buddy46', { tracks: 4, changed: false }, 2000);

  assert.equal(db.row.collector_id, 'buddy46-playback');
  assert.equal(db.row.status, 'ok');
  assert.equal(db.row.last_success_at, 2000);
  assert.equal(db.row.tracks, 4);
  assert.equal(db.row.changed, 0);
  assert.equal(db.calls.filter((call) => call.sql === BUDDY_HEALTH_SCHEMA_SQL).length, 1);
});

test('buddy health preserves unknown track counts as null', async () => {
  resetBuddyHealthForTests();
  const db = new FakeDb();
  const env = { DB: db };

  await recordBuddySuccess(env, 'buddy46', { tracks: null }, 1000);

  assert.equal(db.row.status, 'ok');
  assert.equal(db.row.tracks, null);
});

test('buddy health preserves the last success when a later collection fails', async () => {
  resetBuddyHealthForTests();
  const db = new FakeDb();
  const env = { DB: db };

  await recordBuddySuccess(env, 'buddy46', { tracks: 3 }, 1000);
  await recordBuddyFailure(
    env,
    'buddy46',
    new Error('Stationhead buddy playback response is missing queue tracks'),
    2000,
  );

  assert.equal(db.row.status, 'error');
  assert.equal(db.row.last_attempt_at, 2000);
  assert.equal(db.row.last_success_at, 1000);
  assert.equal(db.row.tracks, 3);
  assert.equal(db.row.failure_code, 'STATIONHEAD_API_CHANGED');
  assert.equal(db.row.failure_stage, 'sh_channel_payload');
  assert.match(db.row.last_error, /missing queue tracks/);
});

test('buddy health does not invent zero metrics for a first-run failure', async () => {
  resetBuddyHealthForTests();
  const db = new FakeDb();
  const env = { DB: db };

  await recordBuddyFailure(env, 'buddy46', new Error('database unavailable'), 2000);

  assert.equal(db.row.status, 'error');
  assert.equal(db.row.last_success_at, null);
  assert.equal(db.row.tracks, null);
});

test('buddy health classifies Stationhead not-found responses as upstream API failures', async () => {
  resetBuddyHealthForTests();
  const db = new FakeDb();
  const env = { DB: db };

  await recordBuddyFailure(
    env,
    'buddy46',
    new Error('Stationhead buddy playback API 404: {"error":{"detail":"Not in database"}}'),
    3000,
  );

  assert.equal(db.row.status, 'error');
  assert.equal(db.row.failure_code, 'STATIONHEAD_API_CHANGED');
  assert.equal(db.row.failure_stage, 'sh_channel_request');
  assert.match(db.row.last_error, /Not in database/);
});
