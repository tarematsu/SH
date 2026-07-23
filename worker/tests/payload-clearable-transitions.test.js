import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const materializedStateMigration = readFileSync(
  new URL('../../database/facts-migrations/032_materialized_cleanup_ranking.sql', import.meta.url),
  'utf8',
);
const transitionFixMigration = readFileSync(
  new URL('../../database/facts-migrations/033_fix_payload_clearable_transitions.sql', import.meta.url),
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
  db.exec(materializedStateMigration);
  db.exec(transitionFixMigration);
  return db;
}

function insertDoneJob(db, id, payload) {
  db.prepare(`INSERT INTO sh_minute_fact_jobs(
      id,status,payload_json,payload_clearable,processed_at,lease_until,last_error,updated_at
    ) VALUES(?,'done',?,0,100,NULL,NULL,100)`).run(id, payload);
}

test('revision source reassignment repairs both the old and new job eligibility', () => {
  const db = database();
  insertDoneJob(db, 1, 'old-owner');
  insertDoneJob(db, 2, 'new-owner');
  db.exec(`INSERT INTO sh_queue_revisions
    VALUES(20,1,'pending',0,2,2);`);

  assert.equal(db.prepare('SELECT payload_clearable FROM sh_minute_fact_jobs WHERE id=1').get().payload_clearable, 0);
  assert.equal(db.prepare('SELECT payload_clearable FROM sh_minute_fact_jobs WHERE id=2').get().payload_clearable, 0);

  db.exec('UPDATE sh_queue_revisions SET source_job_id=2 WHERE id=20;');
  assert.equal(db.prepare('SELECT payload_clearable FROM sh_minute_fact_jobs WHERE id=1').get().payload_clearable, 1);
  assert.equal(db.prepare('SELECT payload_clearable FROM sh_minute_fact_jobs WHERE id=2').get().payload_clearable, 0);

  db.exec(`UPDATE sh_queue_revisions SET
    status='complete',materialized_item_count=2 WHERE id=20;`);
  assert.equal(db.prepare('SELECT payload_clearable FROM sh_minute_fact_jobs WHERE id=2').get().payload_clearable, 1);
});

test('deleting the last blocking revision releases its source payload', () => {
  const db = database();
  insertDoneJob(db, 3, 'delete-owner');
  db.exec(`INSERT INTO sh_queue_revisions
    VALUES(30,3,'pending',0,1,1);`);
  assert.equal(db.prepare('SELECT payload_clearable FROM sh_minute_fact_jobs WHERE id=3').get().payload_clearable, 0);

  db.exec('DELETE FROM sh_queue_revisions WHERE id=30;');
  assert.equal(db.prepare('SELECT payload_clearable FROM sh_minute_fact_jobs WHERE id=3').get().payload_clearable, 1);
});

test('a completed job leaving done state is no longer cleanup eligible', () => {
  const db = database();
  insertDoneJob(db, 4, 'reopened');
  db.exec("UPDATE sh_minute_fact_jobs SET status='processing' WHERE id=4;");
  assert.equal(db.prepare('SELECT payload_clearable FROM sh_minute_fact_jobs WHERE id=4').get().payload_clearable, 0);
});
