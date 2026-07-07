import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUDDY_PLAYBACK_SCHEMA_SQL,
  buddyHandleStationPath,
  collectBuddyPlaybackReady,
  ensureBuddyPlaybackSchema,
  resetBuddyRuntimeForTests,
} from '../src/buddy-runtime.js';

class FakeStatement {
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
    this.sql = [];
    this.state = {
      auth_token: 'stored-auth-value',
      device_uid: 'stored-device-value',
      token_expires_at: Date.now() + 60 * 60 * 1000,
      control_id: 'stationhead',
      last_success_at: 1000,
      lock_until: 0,
    };
    this.authControl = { last_success_at: 1000, lock_until: 0 };
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async first(sql) {
    this.sql.push(sql);
    if (sql.includes('sh_worker_collector_state')) {
      return {
        ...this.state,
        control_id: 'stationhead',
        last_success_at: this.authControl.last_success_at,
        lock_until: this.authControl.lock_until,
      };
    }
    return null;
  }

  async run(sql, params = []) {
    this.sql.push(sql);
    if (sql === BUDDY_PLAYBACK_SCHEMA_SQL) return { meta: { changes: 0 } };
    if (sql.includes('INSERT OR IGNORE INTO sh_worker_auth_control')) {
      return { meta: { changes: 0 } };
    }
    if (sql.includes('UPDATE sh_worker_auth_control SET') && sql.includes('lock_until')) {
      this.authControl.lock_until = params[0];
      return { meta: { changes: 1 } };
    }
    if (sql.includes('INSERT INTO sh_worker_collector_state')) {
      this.state.auth_token = params[1];
      this.state.device_uid = params[2];
      this.state.token_expires_at = params[3];
      return { meta: { changes: 1 } };
    }
    if (sql.includes('UPDATE sh_worker_auth_control SET') && sql.includes('last_success_at')) {
      this.authControl.last_success_at = params[1];
      this.authControl.lock_until = 0;
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 1 } };
  }
}

test('buddy runtime creates the current-state table once per isolate', async () => {
  resetBuddyRuntimeForTests();
  const db = new FakeDb();
  const env = { DB: db };

  assert.equal(await ensureBuddyPlaybackSchema(env), true);
  assert.equal(await ensureBuddyPlaybackSchema(env), false);
  assert.deepEqual(db.sql, [BUDDY_PLAYBACK_SCHEMA_SQL]);
});

test('buddy runtime rejects a missing D1 binding', async () => {
  resetBuddyRuntimeForTests();
  await assert.rejects(ensureBuddyPlaybackSchema({}), /D1 binding is missing/);
});

test('buddy runtime verifies sessions with the handle station endpoint', () => {
  assert.equal(buddyHandleStationPath('buddy46'), '/station/handle/buddy46/guest');
});

test('buddy runtime refreshes the guest session before collection even when stored auth is usable', async () => {
  resetBuddyRuntimeForTests();
  const db = new FakeDb();
  let acquireCalls = 0;
  let collectedAuth = null;
  const result = await collectBuddyPlaybackReady({ DB: db }, 3000, {
    now: () => 3000,
    acquireSession: async () => {
      acquireCalls += 1;
      return { authToken: 'fresh-auth-value', deviceUid: 'fresh-device-value', tokenExpiresAt: 600000 };
    },
    collect: async (env) => {
      collectedAuth = env.__stationheadAuthState;
      return { skipped: false, tracks: 1 };
    },
  });

  assert.equal(result.skipped, false);
  assert.equal(acquireCalls, 1);
  assert.equal(collectedAuth.authToken, 'fresh-auth-value');
  assert.equal(collectedAuth.deviceUid, 'fresh-device-value');
});
