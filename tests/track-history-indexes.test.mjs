import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migration = readFileSync(new URL('../database/migrations/009_track_history_query_indexes.sql', import.meta.url), 'utf8');

test('track history query indexes are repeatable', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_queue_snapshots (
      id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, station_id INTEGER,
      start_time INTEGER, is_paused INTEGER
    );
    CREATE TABLE sh_queue_items (
      id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, station_id INTEGER NOT NULL,
      start_time INTEGER NOT NULL
    );
  `);

  db.exec(migration);
  db.exec(migration);

  const indexes = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map((row) => row.name));
  assert.ok(indexes.has('idx_sh_queue_snapshots_track_history_evidence'));
  assert.ok(indexes.has('idx_sh_queue_snapshots_station_start'));
  assert.ok(indexes.has('idx_sh_queue_items_track_history_evidence'));
});
