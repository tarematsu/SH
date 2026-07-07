import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTH_CONTROL_SCHEMA_SQL,
  ensureAuthControlRow,
  parseAuthState,
  readAuthState,
  resetAuthStateForTests,
} from '../src/auth-state.js';

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.binds = [];
  }

  bind(...args) {
    this.binds = args;
    return this;
  }

  async first() {
    this.db.sql.push(this.sql);
    if (this.sql.includes('sh_worker_auth_control') && !this.db.authTableReady) {
      throw new Error('no such table: sh_worker_auth_control');
    }
    return this.db.row;
  }

  async run() {
    this.db.sql.push(this.sql);
    if (this.sql === AUTH_CONTROL_SCHEMA_SQL) this.db.authTableReady = true;
    return { meta: { changes: 1 } };
  }
}

class FakeDb {
  constructor(row = null) {
    this.row = row;
    this.sql = [];
    this.authTableReady = false;
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }
}

test('readAuthState bootstraps missing auth control table and retries the read', async () => {
  resetAuthStateForTests();
  const db = new FakeDb({
    auth_token: 'token',
    device_uid: 'device-1',
    control_id: 'stationhead',
    lock_until: 0,
  });

  const state = await readAuthState({ DB: db }, 'stationhead');

  assert.equal(state.authToken, 'token');
  assert.equal(state.deviceUid, 'device-1');
  assert.equal(db.sql.includes(AUTH_CONTROL_SCHEMA_SQL), true);
  assert.equal(db.sql.filter((sql) => sql.includes('LEFT JOIN sh_worker_auth_control')).length, 2);
});

test('ensureAuthControlRow creates the auth control table before inserting the row', async () => {
  resetAuthStateForTests();
  const db = new FakeDb();

  await ensureAuthControlRow({ DB: db }, 'stationhead', 123);

  assert.deepEqual(db.sql, [
    AUTH_CONTROL_SCHEMA_SQL,
    'INSERT OR IGNORE INTO sh_worker_auth_control (id,updated_at) VALUES (?,?)',
  ]);
});

test('buddy46 auth state does not fall back to the shared buddies credentials', () => {
  const state = parseAuthState(null, {
    STATIONHEAD_AUTH_TOKEN: 'Bearer buddies-token',
    STATIONHEAD_DEVICE_UID: 'buddies-device',
  }, 'buddy46');

  assert.equal(state.authToken, '');
  assert.equal(state.deviceUid, '');
});

test('buddy46 auth state can use only buddy-scoped fallback credentials', () => {
  const state = parseAuthState(null, {
    STATIONHEAD_AUTH_TOKEN: 'Bearer buddies-token',
    STATIONHEAD_DEVICE_UID: 'buddies-device',
    BUDDY_PLAYBACK_AUTH_TOKEN: 'Bearer buddy-token',
    BUDDY_PLAYBACK_DEVICE_UID: 'buddy-device',
  }, 'buddy46');

  assert.equal(state.authToken, 'buddy-token');
  assert.equal(state.deviceUid, 'buddy-device');
});
