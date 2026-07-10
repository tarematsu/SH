import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { saveQueueCurrentPauseState } from '../functions/lib/queue-current-state.js';

function createDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE sh_queue_current (
    station_id INTEGER PRIMARY KEY,
    is_paused INTEGER,
    observed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
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

test('pause-only queue updates the current state', async () => {
  const db = createDatabase();
  db.sqlite.prepare(`INSERT INTO sh_queue_current
    (station_id,is_paused,observed_at,updated_at) VALUES (?,?,?,?)`).run(10, 0, 100, 100);

  const result = await saveQueueCurrentPauseState(db, 200, {
    station_id: 10,
    is_paused: true,
  }, 250);

  assert.equal(result.updated, true);
  assert.deepEqual(
    db.sqlite.prepare(`SELECT is_paused,observed_at,updated_at
      FROM sh_queue_current WHERE station_id=10`).get(),
    { is_paused: 1, observed_at: 200, updated_at: 250 },
  );
});

test('an older delayed event cannot regress the current pause state', async () => {
  const db = createDatabase();
  db.sqlite.prepare(`INSERT INTO sh_queue_current
    (station_id,is_paused,observed_at,updated_at) VALUES (?,?,?,?)`).run(10, 1, 200, 200);

  const result = await saveQueueCurrentPauseState(db, 150, {
    station_id: 10,
    is_paused: false,
  }, 300);

  assert.equal(result.updated, false);
  assert.deepEqual(
    db.sqlite.prepare(`SELECT is_paused,observed_at,updated_at
      FROM sh_queue_current WHERE station_id=10`).get(),
    { is_paused: 1, observed_at: 200, updated_at: 200 },
  );
});

test('the same pause state is not rewritten', async () => {
  const db = createDatabase();
  db.sqlite.prepare(`INSERT INTO sh_queue_current
    (station_id,is_paused,observed_at,updated_at) VALUES (?,?,?,?)`).run(10, 1, 200, 200);

  const result = await saveQueueCurrentPauseState(db, 300, {
    station_id: 10,
    is_paused: true,
  }, 350);

  assert.equal(result.updated, false);
  assert.deepEqual(
    db.sqlite.prepare(`SELECT is_paused,observed_at,updated_at
      FROM sh_queue_current WHERE station_id=10`).get(),
    { is_paused: 1, observed_at: 200, updated_at: 200 },
  );
});

test('invalid identity or observed time is ignored', async () => {
  const db = createDatabase();
  assert.equal((await saveQueueCurrentPauseState(db, 100, { is_paused: true })).updated, false);
  assert.equal((await saveQueueCurrentPauseState(db, 'bad', {
    station_id: 10,
    is_paused: true,
  })).updated, false);
});
