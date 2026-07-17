import assert from 'node:assert/strict';
import test from 'node:test';

import { collectorStateFromAuthState, saveCollectorStateAndClearFailure } from '../src/collector-state.js';
import { collectRawChannel } from '../src/raw-collector-entry.js';

async function rawMessage(state, headers = {}) {
  const sent = [];
  await collectRawChannel({
    CHANNEL_ALIAS: 'buddies',
    REQUEST_TIMEOUT_MS: 8_000,
    RAW_COLLECTION_QUEUE: {
      async send(message) { sent.push(message); },
    },
  }, {
    ensureSession: async () => state,
    fetch: async () => new Response('{"ok":true}', { status: 200, headers }),
  });
  assert.equal(sent.length, 1);
  return sent[0];
}

test('raw collector requests credential persistence only for missing state or refreshed auth', async () => {
  const stable = await rawMessage({
    authToken: 'token',
    deviceUid: 'device',
    tokenExpiresAt: 9_999_999_999_999,
    collectorUpdatedAt: 1,
  });
  assert.equal(stable.persist_credentials, false);
  assert.equal(stable.auth.authToken, 'token');

  const missing = await rawMessage({
    authToken: 'token',
    deviceUid: 'device',
    tokenExpiresAt: 9_999_999_999_999,
  });
  assert.equal(missing.persist_credentials, true);

  const refreshed = await rawMessage({
    authToken: 'token',
    deviceUid: 'device',
    tokenExpiresAt: 9_999_999_999_999,
    collectorUpdatedAt: 1,
  }, { authorization: 'Bearer refreshed-token' });
  assert.equal(refreshed.persist_credentials, true);
  assert.equal(refreshed.auth.authToken, 'refreshed-token');
});

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

function fakeDb(firstChanges = 1) {
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
      return statements.map((statement, index) => ({
        success: true,
        meta: { changes: index === 0 ? firstChanges : 1 },
        statement,
      }));
    },
  };
}

function state(persistCredentials) {
  return {
    authToken: 'large-jwt-token',
    deviceUid: 'device-id',
    tokenExpiresAt: 123,
    channelId: 10,
    stationId: 20,
    persistCredentials,
  };
}

test('new raw messages update only mutable collector progress columns', async () => {
  const parsed = collectorStateFromAuthState({
    authToken: 'token',
    deviceUid: 'device',
    tokenExpiresAt: 123,
  }, { __shPersistCollectorCredentials: false });
  assert.equal(parsed.persistCredentials, false);

  const db = fakeDb();
  await saveCollectorStateAndClearFailure({ DB: db }, state(false), {
    lastRunAt: 1_000,
    lastSuccessAt: 1_001,
    lastError: null,
  });

  assert.equal(db.batches.length, 1);
  const progress = db.batches[0][0];
  assert.match(progress.sql, /^UPDATE sh_worker_collector_state SET/);
  assert.doesNotMatch(progress.sql, /auth_token|device_uid|token_expires_at/);
  assert.deepEqual(progress.params.slice(0, 5), [1_000, 1_001, null, 10, 20]);
  assert.equal(progress.params.includes('large-jwt-token'), false);
  assert.equal(progress.params.includes('device-id'), false);
});

test('old messages and missing progress rows retain the full credential upsert', async () => {
  const parsed = collectorStateFromAuthState({
    authToken: 'token',
    deviceUid: 'device',
    tokenExpiresAt: 123,
  });
  assert.equal(parsed.persistCredentials, true);

  const oldDb = fakeDb();
  await saveCollectorStateAndClearFailure({ DB: oldDb }, state(true), {
    lastRunAt: 1_000,
    lastSuccessAt: 1_001,
  });
  assert.match(oldDb.batches[0][0].sql, /INSERT INTO sh_worker_collector_state/);

  const missingDb = fakeDb(0);
  await saveCollectorStateAndClearFailure({ DB: missingDb }, state(false), {
    lastRunAt: 2_000,
    lastSuccessAt: 2_001,
  });
  assert.equal(missingDb.runs.length, 1);
  assert.match(missingDb.runs[0].sql, /INSERT INTO sh_worker_collector_state/);
}