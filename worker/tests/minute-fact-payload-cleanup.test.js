import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  CLEAR_COMPLETED_MINUTE_FACT_PAYLOADS_SQL,
  COMPLETE_MINUTE_FACT_JOB_SQL,
} from '../src/minute-facts-inbox.js';

const migration = readFileSync(
  new URL('../../database/facts-migrations/028_purge_completed_minute_fact_payloads.sql', import.meta.url),
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
    );`);
  return db;
}

test('database workflow purges every eligible existing payload in one job using bounded statements', () => {
  assert.doesNotMatch(migration, /UPDATE sh_minute_fact_jobs\s+SET payload_json='\{\}'\s+WHERE status='done'/);
  assert.match(purgeScript, /while \(batches < maxBatches\)/);
  assert.match(purgeScript, /LIMIT \$\{batchSize\}/);
  assert.match(purgeScript, /if \(cleared < batchSize\) break/);
  assert.match(purgeScript, /firstEligibleJobId/);
  assert.match(purgeScript, /remainingEligibleJobId != null/);
  assert.doesNotMatch(purgeScript, /SUM\(LENGTH\(payload_json\)\)/);
  assert.match(databaseWorkflow, /name: Purge completed minute fact payloads/);
  assert.match(databaseWorkflow, /node scripts\/purge-completed-minute-fact-payloads\.mjs/);
});

test('bounded purge clears completed payloads and waits for incomplete revisions', () => {
  const db = database();
  db.exec(`INSERT INTO sh_minute_fact_jobs VALUES
      (1,'done','old-complete',100,NULL,NULL,100),
      (2,'done','revision-pending',100,NULL,NULL,100);
    INSERT INTO sh_queue_revisions VALUES(20,2,'pending',0,3,3);`);

  db.exec(migration);
  const cleared = db.prepare(CLEAR_COMPLETED_MINUTE_FACT_PAYLOADS_SQL).all(200, 1000);
  assert.deepEqual(cleared.map(({ id }) => id), [1]);
  assert.equal(db.prepare('SELECT payload_json FROM sh_minute_fact_jobs WHERE id=1').get().payload_json, '{}');
  assert.equal(
    db.prepare('SELECT payload_json FROM sh_minute_fact_jobs WHERE id=2').get().payload_json,
    'revision-pending',
  );

  db.prepare(`UPDATE sh_queue_revisions SET
    status='complete',materialized_item_count=3 WHERE id=20`).run();
  assert.equal(db.prepare('SELECT payload_json FROM sh_minute_fact_jobs WHERE id=2').get().payload_json, '{}');
});

test('bounded maintenance cleanup remains an idempotent fallback', () => {
  const db = database();
  db.exec(migration);
  db.exec(`INSERT INTO sh_minute_fact_jobs VALUES
      (6,'done','late-backlog',100,NULL,NULL,100);`);
  const cleared = db.prepare(CLEAR_COMPLETED_MINUTE_FACT_PAYLOADS_SQL).all(200, 1000);
  assert.deepEqual(cleared.map(({ id }) => id), [6]);
  assert.equal(db.prepare('SELECT payload_json FROM sh_minute_fact_jobs WHERE id=6').get().payload_json, '{}');
  assert.deepEqual(db.prepare(CLEAR_COMPLETED_MINUTE_FACT_PAYLOADS_SQL).all(201, 1000), []);
});

test('job completion clears immediately when its revision already finished', () => {
  const db = database();
  db.exec(migration);
  db.exec(`INSERT INTO sh_minute_fact_jobs VALUES
      (3,'processing','completion-last',NULL,999,NULL,100);
    INSERT INTO sh_queue_revisions VALUES(30,3,'complete',4,4,4);`);

  db.prepare(COMPLETE_MINUTE_FACT_JOB_SQL).run(200, 200, 3);
  const row = db.prepare(`SELECT status,payload_json,processed_at,lease_until
    FROM sh_minute_fact_jobs WHERE id=3`).get();
  assert.deepEqual({ ...row }, {
    status: 'done',
    payload_json: '{}',
    processed_at: 200,
    lease_until: null,
  });
});

test('database trigger also clears jobs completed outside the normal helper', () => {
  const db = database();
  db.exec(migration);
  db.exec(`INSERT INTO sh_minute_fact_jobs VALUES
      (5,'processing','trigger-completion',NULL,999,NULL,100);`);
  db.exec(`UPDATE sh_minute_fact_jobs SET status='done',processed_at=200 WHERE id=5;`);
  assert.equal(db.prepare('SELECT payload_json FROM sh_minute_fact_jobs WHERE id=5').get().payload_json, '{}');
});

test('one completed revision cannot clear a payload while another revision is pending', () => {
  const db = database();
  db.exec(migration);
  db.exec(`INSERT INTO sh_minute_fact_jobs VALUES
      (4,'done','two-revisions',100,NULL,NULL,100);
    INSERT INTO sh_queue_revisions VALUES
      (40,4,'pending',0,2,2),
      (41,4,'pending',0,1,1);`);

  db.exec(`UPDATE sh_queue_revisions SET status='complete',materialized_item_count=2 WHERE id=40;`);
  assert.equal(db.prepare('SELECT payload_json FROM sh_minute_fact_jobs WHERE id=4').get().payload_json, 'two-revisions');
  db.exec(`UPDATE sh_queue_revisions SET status='complete',materialized_item_count=1 WHERE id=41;`);
  assert.equal(db.prepare('SELECT payload_json FROM sh_minute_fact_jobs WHERE id=4').get().payload_json, '{}');
});
