import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  CLEAR_COMPLETED_MINUTE_FACT_PAYLOADS_SQL,
  COMPLETE_MINUTE_FACT_JOB_SQL,
} from '../src/minute-facts-inbox.js';
import {
  payloadPurgeBatch,
  payloadPurgeStatement,
  purgeCompletedMinuteFactPayloads,
  summarizePurgeBatch,
} from '../scripts/purge-completed-minute-fact-payloads.mjs';

const migration = readFileSync(
  new URL('../../database/facts-migrations/032_materialized_cleanup_ranking.sql', import.meta.url),
  'utf8',
);
const purgeScript = readFileSync(
  new URL('../scripts/purge-completed-minute-fact-payloads.mjs', import.meta.url),
  'utf8',
);
const databaseWorkflow = readFileSync(
  new URL('../../.github/workflows/database.yml', import.meta.url),
  'utf8',
);

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sh_minute_fact_jobs(
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      processed_at INTEGER,
      lease_until INTEGER,
      last_error TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE sh_queue_revisions(
      id INTEGER PRIMARY KEY,
      source_job_id INTEGER,
      status TEXT NOT NULL,
      materialized_item_count INTEGER NOT NULL DEFAULT 0,
      source_visible_count INTEGER,
      item_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sh_tracks(
      id INTEGER PRIMARY KEY,title TEXT,artist TEXT,isrc TEXT,spotify_id TEXT
    );
    CREATE TABLE sh_track_counter_current(
      occurrence_key TEXT PRIMARY KEY,observed_at INTEGER NOT NULL,
      count_value INTEGER NOT NULL,track_key TEXT NOT NULL,track_id INTEGER,
      isrc TEXT,spotify_id TEXT
    );`);
  return db;
}

function applyMigration(db) {
  db.exec(migration);
  return db;
}

function response(result, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    async json() {
      return options.body ?? { success: true, result };
    },
  };
}

test('database workflow drains every eligible payload through batched D1 API requests', () => {
  assert.match(migration, /idx_sh_minute_fact_jobs_payload_clearable/);
  assert.match(migration, /payload_clearable=CASE/);
  assert.match(purgeScript, /api\.cloudflare\.com\/client\/v4\/accounts/);
  assert.match(purgeScript, /payloadPurgeBatch/);
  assert.match(purgeScript, /statementsPerRequest/);
  assert.match(purgeScript, /minute_fact_payload_purge_retry/);
  assert.match(purgeScript, /payload_clearable=1/);
  assert.doesNotMatch(purgeScript, /execFileSync|wranglerScript/);
  assert.doesNotMatch(purgeScript, /RETURNING id/);
  assert.doesNotMatch(purgeScript, /SUM\(LENGTH\(payload_json\)\)/);
  assert.match(databaseWorkflow, /name: Purge completed minute fact payloads/);
  assert.match(databaseWorkflow, /node scripts\/purge-completed-minute-fact-payloads\.mjs/);
  assert.match(databaseWorkflow, /- payload-purge/);
  assert.match(databaseWorkflow, /inputs\.operation == 'payload-purge'/);
  assert.match(databaseWorkflow, /name: Drain existing stationhead-minute payload backlog/);
  assert.match(databaseWorkflow, /name: Drain all eligible payload backlog/);
  assert.match(databaseWorkflow, /MINUTE_FACT_PAYLOAD_PURGE_BATCH_SIZE: '1000'/);
  assert.match(databaseWorkflow, /MINUTE_FACT_PAYLOAD_PURGE_STATEMENTS_PER_REQUEST: '20'/);
  assert.match(databaseWorkflow, /payload-purge:[\s\S]*?timeout-minutes: 120/);
});

test('payload purge request contains bounded indexed updates', () => {
  const sql = payloadPurgeStatement(1000);
  assert.match(sql, /LIMIT 1000/);
  assert.match(sql, /payload_clearable=1/);
  assert.doesNotMatch(sql, /NOT EXISTS/);
  assert.doesNotMatch(sql, /RETURNING/);

  const payload = payloadPurgeBatch(1000, 3);
  assert.equal(payload.batch.length, 3);
  assert.ok(payload.batch.every((entry) => entry.sql === sql));
  assert.deepEqual(
    summarizePurgeBatch([
      { meta: { changes: 1000 } },
      { meta: { changes: 250 } },
      { meta: { changes: 0 } },
    ], 1000),
    { cleared: 1250, completed: true, statements: 3 },
  );
});

test('one purge invocation drains multiple statements and verifies completion', async () => {
  const calls = [];
  const fetchImpl = async (url, request) => {
    const payload = JSON.parse(request.body);
    calls.push({ url, request, payload });
    if (calls.length === 1) {
      return response([
        { success: true, results: [], meta: { changes: 1000 } },
        { success: true, results: [], meta: { changes: 1000 } },
        { success: true, results: [], meta: { changes: 250 } },
      ]);
    }
    return response([
      { success: true, results: [], meta: { changes: 0 } },
      { success: true, results: [{ id: 99 }], meta: { changes: 0 } },
    ]);
  };

  const summary = await purgeCompletedMinuteFactPayloads({
    accountId: 'account',
    apiToken: 'token',
    databaseId: 'database',
    databaseName: 'stationhead-minute',
    batchSize: 1000,
    statementsPerRequest: 3,
    maxBatches: 10,
    maxAttempts: 1,
    fetchImpl,
  });

  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].url,
    'https://api.cloudflare.com/client/v4/accounts/account/d1/database/database/query',
  );
  assert.equal(calls[0].request.headers.authorization, 'Bearer token');
  assert.equal(calls[0].payload.batch.length, 3);
  assert.equal(calls[1].payload.batch.length, 2);
  assert.deepEqual(summary, {
    ok: true,
    event: 'minute_fact_payload_purge_complete',
    database_name: 'stationhead-minute',
    database_id: 'database',
    batch_size: 1000,
    statements_per_request: 3,
    requests: 1,
    batches: 3,
    cleared_jobs: 2250,
    remaining_eligible_job_id: null,
    blocked_revision_payloads_remain: true,
  });
});

test('migration backfill marks only payloads without incomplete revisions', () => {
  const db = database();
  db.exec(`INSERT INTO sh_minute_fact_jobs(
      id,status,payload_json,processed_at,lease_until,last_error,updated_at
    ) VALUES
      (1,'done','old-complete',100,NULL,NULL,100),
      (2,'done','revision-pending',100,NULL,NULL,100);
    INSERT INTO sh_queue_revisions VALUES(20,2,'pending',0,3,3);`);
  applyMigration(db);

  assert.equal(db.prepare('SELECT payload_clearable FROM sh_minute_fact_jobs WHERE id=1').get().payload_clearable, 1);
  assert.equal(db.prepare('SELECT payload_clearable FROM sh_minute_fact_jobs WHERE id=2').get().payload_clearable, 0);
  const cleared = db.prepare(CLEAR_COMPLETED_MINUTE_FACT_PAYLOADS_SQL).all(200, 1000);
  assert.deepEqual(cleared.map(({ id }) => id), [1]);

  db.prepare(`UPDATE sh_queue_revisions SET
    status='complete',materialized_item_count=3 WHERE id=20`).run();
  assert.equal(db.prepare('SELECT payload_clearable FROM sh_minute_fact_jobs WHERE id=2').get().payload_clearable, 1);
  assert.equal(db.prepare('SELECT payload_json FROM sh_minute_fact_jobs WHERE id=2').get().payload_json, 'revision-pending');
  db.prepare(CLEAR_COMPLETED_MINUTE_FACT_PAYLOADS_SQL).all(201, 1000);
  assert.equal(db.prepare('SELECT payload_json FROM sh_minute_fact_jobs WHERE id=2').get().payload_json, '{}');
});

test('bounded maintenance cleanup remains idempotent', () => {
  const db = applyMigration(database());
  db.exec(`INSERT INTO sh_minute_fact_jobs(
      id,status,payload_json,payload_clearable,processed_at,lease_until,last_error,updated_at
    ) VALUES(6,'done','late-backlog',1,100,NULL,NULL,100);`);
  const cleared = db.prepare(CLEAR_COMPLETED_MINUTE_FACT_PAYLOADS_SQL).all(200, 1000);
  assert.deepEqual(cleared.map(({ id }) => id), [6]);
  assert.equal(db.prepare('SELECT payload_json FROM sh_minute_fact_jobs WHERE id=6').get().payload_json, '{}');
  assert.deepEqual(db.prepare(CLEAR_COMPLETED_MINUTE_FACT_PAYLOADS_SQL).all(201, 1000), []);
});

test('job completion marks payload clearable when its revision already finished', () => {
  const db = applyMigration(database());
  db.exec(`INSERT INTO sh_minute_fact_jobs(
      id,status,payload_json,payload_clearable,processed_at,lease_until,last_error,updated_at
    ) VALUES(3,'processing','completion-last',0,NULL,999,NULL,100);
    INSERT INTO sh_queue_revisions VALUES(30,3,'complete',4,4,4);`);

  db.prepare(COMPLETE_MINUTE_FACT_JOB_SQL).run(200, 200, 3);
  const row = db.prepare(`SELECT status,payload_json,payload_clearable,processed_at,lease_until
    FROM sh_minute_fact_jobs WHERE id=3`).get();
  assert.deepEqual({ ...row }, {
    status: 'done',
    payload_json: 'completion-last',
    payload_clearable: 1,
    processed_at: 200,
    lease_until: null,
  });
});

test('one completed revision cannot mark a payload while another revision is pending', () => {
  const db = applyMigration(database());
  db.exec(`INSERT INTO sh_minute_fact_jobs(
      id,status,payload_json,payload_clearable,processed_at,lease_until,last_error,updated_at
    ) VALUES(4,'done','two-revisions',0,100,NULL,NULL,100);
    INSERT INTO sh_queue_revisions VALUES
      (40,4,'pending',0,2,2),
      (41,4,'pending',0,1,1);`);

  db.exec(`UPDATE sh_queue_revisions SET status='complete',materialized_item_count=2 WHERE id=40;`);
  assert.equal(db.prepare('SELECT payload_clearable FROM sh_minute_fact_jobs WHERE id=4').get().payload_clearable, 0);
  db.exec(`UPDATE sh_queue_revisions SET status='complete',materialized_item_count=1 WHERE id=41;`);
  assert.equal(db.prepare('SELECT payload_clearable FROM sh_minute_fact_jobs WHERE id=4').get().payload_clearable, 1);
});
