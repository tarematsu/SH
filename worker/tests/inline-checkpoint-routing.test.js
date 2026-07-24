import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  collectorStateFromAuthState,
  saveCollectorStateAndClearFailure,
  successfulCollectorStatePersistenceDue,
} from '../src/collector-state.js';

const CHECKPOINT_MS = 20 * 60_000;

function state(overrides = {}, env = {}) {
  return collectorStateFromAuthState({
    authToken: 'Bearer test-token',
    deviceUid: 'test-device',
    tokenExpiresAt: 9_999_999_999_999,
    collectorLastRunAt: 1_000,
    collectorLastSuccessAt: 1_000,
    collectorLastError: null,
    collectorChannelId: 10,
    collectorStationId: 20,
    ...overrides,
  }, {
    __shPersistCollectorCredentials: false,
    ...env,
  });
}

function recordingDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind() { return this; },
        async run() {
          calls.push(String(sql));
          return { meta: { changes: 1 } };
        },
      };
    },
  };
}

test('inline collector success skips stable progress before the twenty-minute checkpoint', async () => {
  const db = recordingDb();
  const current = state();

  Object.assign(current, {
    lastRunAt: 1_000 + CHECKPOINT_MS - 1,
    lastSuccessAt: 1_000 + CHECKPOINT_MS - 1,
    lastError: null,
    channelId: 10,
    stationId: 20,
  });

  assert.equal(successfulCollectorStatePersistenceDue(current), false);
  await saveCollectorStateAndClearFailure({ DB: db }, current);
  assert.equal(db.calls.length, 0);
});

test('inline collector persists checkpoints, identity changes, and credential refreshes immediately', async () => {
  const checkpointDb = recordingDb();
  const checkpoint = state();
  await saveCollectorStateAndClearFailure({ DB: checkpointDb }, checkpoint, {
    lastRunAt: 1_000 + CHECKPOINT_MS,
    lastSuccessAt: 1_000 + CHECKPOINT_MS,
  });
  assert.equal(checkpointDb.calls.length, 1);

  const identityDb = recordingDb();
  const identity = state();
  await saveCollectorStateAndClearFailure({ DB: identityDb }, identity, {
    lastRunAt: 61_000,
    lastSuccessAt: 61_000,
    channelId: 11,
  });
  assert.equal(identityDb.calls.length, 1);

  const credentialsDb = recordingDb();
  const credentials = state({}, { __shPersistCollectorCredentials: true });
  await saveCollectorStateAndClearFailure({ DB: credentialsDb }, credentials, {
    lastRunAt: 61_000,
    lastSuccessAt: 61_000,
  });
  assert.equal(credentialsDb.calls.length, 1);
});

test('production minute ingestion routes read models through the guarded checkpoint writer', () => {
  const source = readFileSync(new URL('../src/minute-production-entry.js', import.meta.url), 'utf8');
  assert.match(source, /import\('\.\/read-model-stages\.js'\)/);
  assert.match(source, /prepareReadModelForWrite/);
  assert.match(source, /writePreparedReadModel/);
  assert.doesNotMatch(source, /import\('\.\/minute-facts-read-model\.js'\)/);
});
