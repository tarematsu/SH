import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { writePreparedReadModel } from '../src/read-model-stages.js';

class Statement {
  constructor(owner, sql, binds = []) {
    this.owner = owner;
    this.sql = sql;
    this.binds = binds;
  }

  bind(...binds) {
    return new Statement(this.owner, this.sql, binds);
  }
}

class D1Adapter {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.changeSets = [];
    this.sqlite.exec(`CREATE TABLE sh_channel_read_model(
        channel_id INTEGER PRIMARY KEY,observed_at INTEGER,presentation_json TEXT
      );
      CREATE TABLE sh_queue_read_model_current(
        channel_id INTEGER PRIMARY KEY,observed_at INTEGER,station_id INTEGER,queue_id INTEGER,
        start_time INTEGER,is_paused INTEGER,queue_json TEXT
      );
      CREATE TABLE sh_collector_read_model(
        collector_id TEXT PRIMARY KEY,last_run_at INTEGER,last_success_at INTEGER,
        last_error_present INTEGER,updated_at INTEGER
      );`);
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    const changes = statements.map((statement) => (
      this.sqlite.prepare(statement.sql).run(...statement.binds).changes
    ));
    this.changeSets.push(changes);
    return changes.map((count) => ({ success: true, meta: { changes: count } }));
  }
}

function model(at, overrides = {}) {
  return {
    channel: {
      channel_id: 7,
      observed_at: at,
      presentation: { title: 'Stable' },
      ...(overrides.channel || {}),
    },
    queue: {
      station_id: 11,
      queue_id: 12,
      start_time: 1_000,
      is_paused: false,
      value: { tracks: [{ position: 0, spotify_id: 'sp-1' }] },
      ...(overrides.queue || {}),
    },
    collector: {
      collector_id: 'minute',
      last_run_at: at,
      last_success_at: at,
      last_error_present: false,
      updated_at: at,
      ...(overrides.collector || {}),
    },
  };
}

test('unchanged read models skip minute-only timestamp writes until the five-minute checkpoint', async () => {
  const db = new D1Adapter();
  await writePreparedReadModel({ MINUTE_DB: db }, model(1_000));
  await writePreparedReadModel({ MINUTE_DB: db }, model(61_000));
  await writePreparedReadModel({ MINUTE_DB: db }, model(301_000));

  assert.deepEqual(db.changeSets[0], [1, 1, 1]);
  assert.deepEqual(db.changeSets[1], [0, 0, 0]);
  assert.deepEqual(db.changeSets[2], [1, 1, 1]);
});

test('payload, queue, pause, and collector error changes persist immediately', async () => {
  const db = new D1Adapter();
  await writePreparedReadModel({ MINUTE_DB: db }, model(1_000));
  await writePreparedReadModel({ MINUTE_DB: db }, model(61_000, {
    channel: { presentation: { title: 'Changed' } },
    queue: { is_paused: true },
    collector: { last_error_present: true },
  }));

  assert.deepEqual(db.changeSets[1], [1, 1, 1]);
  const channel = db.sqlite.prepare('SELECT * FROM sh_channel_read_model').get();
  const queue = db.sqlite.prepare('SELECT * FROM sh_queue_read_model_current').get();
  const collector = db.sqlite.prepare('SELECT * FROM sh_collector_read_model').get();
  assert.equal(JSON.parse(channel.presentation_json).title, 'Changed');
  assert.equal(queue.is_paused, 1);
  assert.equal(collector.last_error_present, 1);
});

test('older read model payloads cannot replace current state', async () => {
  const db = new D1Adapter();
  await writePreparedReadModel({ MINUTE_DB: db }, model(301_000));
  await writePreparedReadModel({ MINUTE_DB: db }, model(1_000, {
    channel: { presentation: { title: 'Old' } },
    queue: { is_paused: true },
    collector: { last_error_present: true },
  }));

  assert.deepEqual(db.changeSets[1], [0, 0, 0]);
  assert.equal(JSON.parse(db.sqlite.prepare('SELECT presentation_json FROM sh_channel_read_model').get().presentation_json).title, 'Stable');
});
