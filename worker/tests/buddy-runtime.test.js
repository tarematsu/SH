import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUDDY_PLAYBACK_SCHEMA_SQL,
  ensureBuddyPlaybackSchema,
  resetBuddyRuntimeForTests,
} from '../src/buddy-runtime.js';

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }

  run() {
    this.db.sql.push(this.sql);
    return Promise.resolve({ meta: { changes: 0 } });
  }
}

class FakeDb {
  constructor() {
    this.sql = [];
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
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
