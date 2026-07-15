import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  QUEUE_REACHABILITY_CHECKPOINT_MS,
  saveQueueReachability,
} from '../functions/lib/queue-reachability.js';
import { FakeD1Database } from './helpers/fake-d1.js';

function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE sh_queue_snapshots (
    id INTEGER PRIMARY KEY,
    observed_at INTEGER NOT NULL,
    station_id INTEGER,
    queue_id INTEGER,
    start_time INTEGER,
    is_paused INTEGER,
    raw_json TEXT NOT NULL
  )`);
  return {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            async run() {
              const result = statement.run(...params);
              return { meta: { changes: Number(result.changes || 0) } };
            },
          };
        },
      };
    },
  };
}

test('queue reachability writes a compact checkpoint for unchanged queues', async () => {
  const db = new FakeD1Database();
  const observedAt = 1_700_000_000_000;
  const result = await saveQueueReachability(db, observedAt, {
    station_id: 10,
    queue_id: 20,
    start_time: 30,
    is_paused: false,
  });

  assert.equal(result.inserted, true);
  assert.equal(db.calls.length, 1);
  const [call] = db.calls;
  assert.equal(call.kind, 'run');
  assert.match(call.sql, /INSERT INTO sh_queue_snapshots/);
  assert.match(call.sql, /ORDER BY prior\.observed_at DESC,prior\.id DESC/);
  assert.equal(call.params[0], observedAt);
  assert.equal(call.params[11], observedAt);
  assert.equal(call.params[12], observedAt - QUEUE_REACHABILITY_CHECKPOINT_MS);
  assert.equal(call.params[13], 0);
  assert.equal(call.params[5], '{"checkpoint":true}');
});

test('queue reachability preserves paused state for historical reconstruction', async () => {
  const db = new FakeD1Database();
  await saveQueueReachability(db, 1_700_000_120_000, {
    station_id: 10,
    queue_id: 20,
    start_time: 30,
    is_paused: true,
  });

  assert.equal(db.calls[0].params[4], 1);
  assert.equal(db.calls[0].params[13], 1);
});

test('a future row does not suppress a delayed state transition', async () => {
  const db = sqliteD1();
  const future = 1_700_000_120_000;
  const delayed = future - 30_000;
  const data = { station_id: 10, queue_id: 20, start_time: 30, is_paused: false };

  assert.equal((await saveQueueReachability(db, future, data)).inserted, true);
  assert.equal((await saveQueueReachability(db, delayed, data)).inserted, true);

  const row = db.sqlite.prepare('SELECT COUNT(*) AS count FROM sh_queue_snapshots').get();
  assert.equal(row.count, 2);
});

test('rapid pause and resume transitions are never throttled away', async () => {
  const db = sqliteD1();
  const start = 1_700_000_000_000;
  const base = { station_id: 10, queue_id: 20, start_time: 30 };

  assert.equal((await saveQueueReachability(db, start, { ...base, is_paused: false })).inserted, true);
  assert.equal((await saveQueueReachability(db, start + 60_000, { ...base, is_paused: true })).inserted, true);
  assert.equal((await saveQueueReachability(db, start + 90_000, { ...base, is_paused: false })).inserted, true);

  const rows = db.sqlite.prepare(`SELECT is_paused FROM sh_queue_snapshots
    ORDER BY observed_at,id`).all();
  assert.deepEqual(rows.map((row) => row.is_paused), [0, 1, 0]);
});

test('the exact one minute boundary writes a new checkpoint', async () => {
  const db = sqliteD1();
  const start = 1_700_000_000_000;
  const data = { station_id: 10, queue_id: 20, start_time: 30, is_paused: false };

  assert.equal((await saveQueueReachability(db, start, data)).inserted, true);
  assert.equal((await saveQueueReachability(db, start + 30_000, data)).inserted, false);
  assert.equal((await saveQueueReachability(db, start + QUEUE_REACHABILITY_CHECKPOINT_MS, data)).inserted, true);

  const row = db.sqlite.prepare('SELECT COUNT(*) AS count FROM sh_queue_snapshots').get();
  assert.equal(row.count, 2);
});

test('queue reachability skips invalid queue identities inside SQL', async () => {
  const db = new FakeD1Database();
  await saveQueueReachability(db, 1_700_000_120_000, {
    queue_id: 20,
    is_paused: false,
  });

  const params = db.calls[0].params;
  assert.equal(params[1], null);
  assert.equal(params[3], null);
  assert.match(db.calls[0].sql, /WHERE \? IS NOT NULL AND \? IS NOT NULL AND \? IS NOT NULL/);
});

test('queue reachability rejects an invalid observed time inside SQL', async () => {
  const db = new FakeD1Database();
  await saveQueueReachability(db, 'not-a-time', {
    station_id: 10,
    queue_id: 20,
    start_time: 30,
    is_paused: false,
  });

  const params = db.calls[0].params;
  assert.equal(params[0], null);
  assert.equal(params[6], null);
  assert.equal(params[11], null);
  assert.equal(params[12], null);
});
