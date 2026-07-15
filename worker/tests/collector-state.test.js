import assert from 'node:assert/strict';
import test from 'node:test';

import { saveCollectorStateAndClearFailure } from '../src/collector-state.js';

class Statement {
  constructor(sql) {
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async run() {
    return { meta: { changes: 1 } };
  }
}

test('successful collector state and failure cleanup share one D1 batch', async () => {
  const db = {
    prepared: [],
    batches: [],
    prepare(sql) {
      const statement = new Statement(sql);
      this.prepared.push(statement);
      return statement;
    },
    async batch(statements) {
      this.batches.push(statements);
    },
  };
  const state = {
    authToken: 'token',
    deviceUid: 'device',
    tokenExpiresAt: 123,
    channelId: 10,
    stationId: 20,
  };

  await saveCollectorStateAndClearFailure({ DB: db }, state, {
    lastRunAt: 1_000,
    lastSuccessAt: 1_001,
    lastError: null,
  });

  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0].length, 2);
  assert.match(db.batches[0][0].sql, /INSERT INTO sh_worker_collector_state/);
  assert.match(db.batches[0][1].sql, /DELETE FROM sh_collector_failure_state/);
  assert.equal(state.lastRunAt, 1_000);
  assert.equal(state.lastSuccessAt, 1_001);
});
