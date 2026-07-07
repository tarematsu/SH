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
    if (sql.includes('sh_collector_heartbeats')) return this.row;
    return null;
  }

  async run(sql, params) {
    this.calls.push({ kind: 'run', sql, params });
    if (sql.includes('INSERT INTO sh_collector_heartbeats')) {
      this.row = {
        collector_id: params[0],
        first_seen_at: this.row?.first_seen_at ?? params[1],
        last_seen_at: params[2],
        metadata_json: params[5],
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

  const metadata = JSON.parse(db.row.metadata_json);
  assert.equal(db.row.collector_id, 'buddy46-playback');
  assert.equal(metadata.status, 'ok');
  assert.equal(metadata.last_success_at, 2000);
  assert.equal(metadata.tracks, 4);
  assert.equal(metadata.changed, false);
  assert.equal(db.calls.filter((call) => call.sql === BUDDY_HEALTH_SCHEMA_SQL).length, 1);
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

  const metadata = JSON.parse(db.row.metadata_json);
  assert.equal(metadata.status, 'error');
  assert.equal(metadata.last_attempt_at, 2000);
  assert.equal(metadata.last_success_at, 1000);
  assert.equal(metadata.failure_code, 'STATIONHEAD_API_CHANGED');
  assert.equal(metadata.failure_stage, 'stationhead_channel_payload');
  assert.match(metadata.last_error, /missing queue tracks/);
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

  const metadata = JSON.parse(db.row.metadata_json);
  assert.equal(metadata.status, 'error');
  assert.equal(metadata.failure_code, 'STATIONHEAD_API_CHANGED');
  assert.equal(metadata.failure_stage, 'stationhead_channel_request');
  assert.match(metadata.last_error, /Not in database/);
});
