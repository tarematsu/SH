import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { processIngestFinalizeTask } from '../src/ingest-finalize-entry.js';

const MINUTE_MS = 60_000;
const CHECKPOINT_MS = 20 * MINUTE_MS;

function d1Database(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(String(sql));
      let params = [];
      const wrapped = {
        bind(...values) {
          params = values;
          return wrapped;
        },
        async run() {
          const result = statement.run(...params);
          return { success: true, meta: { changes: Number(result.changes || 0) } };
        },
        async first() {
          return statement.get(...params) || null;
        },
      };
      return wrapped;
    },
  };
}

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE sh_worker_collector_state(
      id TEXT PRIMARY KEY,auth_token TEXT,device_uid TEXT,token_expires_at INTEGER,
      last_run_at INTEGER,last_success_at INTEGER,last_error TEXT,
      last_channel_id INTEGER,last_station_id INTEGER,updated_at INTEGER
    );
    CREATE TABLE sh_collector_failure_state(id TEXT PRIMARY KEY);
    INSERT INTO sh_worker_collector_state VALUES(
      'stationhead','token','device',9999999999999,1000,1000,NULL,10,20,1000
    );`);
  return { sqlite, env: { DB: d1Database(sqlite) } };
}

async function finalize(env, state) {
  return processIngestFinalizeTask(env, {
    message_type: 'stationhead-ingest-finalize',
    message_version: 1,
    observed_at: state.lastRunAt,
    channel_id: state.channelId,
    collector_state: state,
    read_model: { message_type: 'stationhead-read-model', job_id: `read-model:${state.channelId}:${state.lastRunAt}` },
  }, {
    sendReadModel: async () => {},
  });
}

test('stable collector progress writes only at the twenty-minute boundary', async () => {
  const { sqlite, env } = fixture();
  const stable = {
    authToken: 'token',
    deviceUid: 'device',
    tokenExpiresAt: 9_999_999_999_999,
    lastSuccessAt: 1000,
    lastError: null,
    channelId: 10,
    stationId: 20,
    persistCredentials: false,
    checkpointDue: true,
  };

  const early = await finalize(env, { ...stable, lastRunAt: 1000 + CHECKPOINT_MS - 1 });
  assert.equal(early.state_accepted, false);
  assert.equal(early.state_persisted, false);
  assert.equal(
    sqlite.prepare("SELECT last_run_at FROM sh_worker_collector_state WHERE id='stationhead'").get().last_run_at,
    1000,
  );

  const dueAt = 1000 + CHECKPOINT_MS;
  const due = await finalize(env, { ...stable, lastRunAt: dueAt, lastSuccessAt: dueAt });
  assert.equal(due.state_accepted, true);
  assert.equal(due.state_persisted, true);
  assert.equal(
    sqlite.prepare("SELECT last_run_at FROM sh_worker_collector_state WHERE id='stationhead'").get().last_run_at,
    dueAt,
  );
});

test('collector identity, credentials and recovery still persist immediately', async () => {
  const { sqlite, env } = fixture();
  const base = {
    authToken: 'token',
    deviceUid: 'device',
    tokenExpiresAt: 9_999_999_999_999,
    lastRunAt: 1001,
    lastSuccessAt: 1001,
    lastError: null,
    channelId: 10,
    stationId: 20,
    persistCredentials: false,
    checkpointDue: true,
  };

  const identity = await finalize(env, { ...base, channelId: 11 });
  assert.equal(identity.state_persisted, true);
  assert.equal(
    sqlite.prepare("SELECT last_channel_id FROM sh_worker_collector_state WHERE id='stationhead'").get().last_channel_id,
    11,
  );

  const credentials = await finalize(env, {
    ...base,
    authToken: 'refreshed-token',
    channelId: 11,
    lastRunAt: 1002,
    lastSuccessAt: 1002,
    persistCredentials: true,
  });
  assert.equal(credentials.state_persisted, true);
  assert.equal(
    sqlite.prepare("SELECT auth_token FROM sh_worker_collector_state WHERE id='stationhead'").get().auth_token,
    'refreshed-token',
  );

  sqlite.exec(`UPDATE sh_worker_collector_state SET last_error='boom' WHERE id='stationhead';
    INSERT INTO sh_collector_failure_state VALUES('stationhead');`);
  const recovery = await finalize(env, {
    ...base,
    authToken: 'refreshed-token',
    channelId: 11,
    lastRunAt: 1003,
    lastSuccessAt: 1003,
    clearFailureOnSuccess: true,
  });
  assert.equal(recovery.state_persisted, true);
  assert.equal(
    sqlite.prepare("SELECT last_error FROM sh_worker_collector_state WHERE id='stationhead'").get().last_error,
    null,
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM sh_collector_failure_state WHERE id='stationhead'").get().count,
    0,
  );
});

test('production metadata cadence is not shorter than the collector checkpoint', () => {
  const runtime = JSON.parse(readFileSync(new URL('../wrangler.runtime.jsonc', import.meta.url), 'utf8'));
  const preparedCollector = readFileSync(new URL('../src/prepared-collector-runner.js', import.meta.url), 'utf8');
  const finalizeSource = readFileSync(new URL('../src/ingest-finalize-entry.js', import.meta.url), 'utf8');

  assert.match(preparedCollector, /COLLECTOR_STATE_CHECKPOINT_MS = 20 \* 60_000/);
  assert.match(finalizeSource, /COLLECTOR_STATE_CHECKPOINT_MS = 20 \* 60_000/);
  assert.ok(Number(runtime.vars.METADATA_REFRESH_INTERVAL_MS) >= CHECKPOINT_MS);
});
