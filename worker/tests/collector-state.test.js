import assert from 'node:assert/strict';
import test from 'node:test';

import { collectorStateFromAuthState, saveCollectorStateAndClearFailure } from '../src/collector-state.js';

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
    this.db.runs.push(this);
    return { meta: { changes: 1 } };
  }
}

function fakeDb() {
  return {
    prepared: [],
    batches: [],
    runs: [],
    prepare(sql) {
      const statement = new Statement(this, sql);
      this.prepared.push(statement);
      return statement;
    },
    async batch(statements) {
      this.batches.push(statements);
      return statements.map((statement) => ({
        success: true,
        meta: { changes: 1 },
        statement,
      }));
    },
  };
}

function state(lastError = null) {
  return collectorStateFromAuthState({
    authToken: 'token',
    deviceUid: 'device',
    tokenExpiresAt: 123,
    collectorLastError: lastError,
    collectorChannelId: 10,
    collectorStationId: 20,
  });
}

test('clean collector success skips failure cleanup and persists one statement', async () => {
  const db = fakeDb();
  const current = state();

  await saveCollectorStateAndClearFailure({ DB: db }, current, {
    lastRunAt: 1_000,
    lastSuccessAt: 1_001,
    lastError: null,
  });

  assert.equal(db.batches.length, 0);
  assert.equal(db.runs.length, 1);
  assert.match(db.runs[0].sql, /INSERT INTO sh_worker_collector_state/);
  assert.equal(db.prepared.some(({ sql }) => /DELETE FROM sh_collector_failure_state/.test(sql)), false);
  assert.equal(current.lastRunAt, 1_000);
  assert.equal(current.lastSuccessAt, 1_001);
});

test('success after a collector error batches state recovery and failure cleanup', async () => {
  const db = fakeDb();
  const current = state('previous failure');
  assert.equal(Object.keys(current).includes('clearFailureOnSuccess'), false);

  await saveCollectorStateAndClearFailure({ DB: db }, current, {
    lastRunAt: 2_000,
    lastSuccessAt: 2_001,
    lastError: null,
  });

  assert.equal(db.runs.length, 0);
  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0].length, 2);
  assert.match(db.batches[0][0].sql, /INSERT INTO sh_worker_collector_state/);
  assert.match(db.batches[0][1].sql, /DELETE FROM sh_collector_failure_state/);
});