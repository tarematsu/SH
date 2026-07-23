import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const repairMigration = readFileSync(
  new URL('../database/facts-migrations/015_repair_track_history_queue_views.sql', import.meta.url),
  'utf8',
);
const compactMigration = readFileSync(
  new URL('../database/facts-migrations/030_compact_track_history_source.sql', import.meta.url),
  'utf8',
);

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_queue_revisions (
      id INTEGER PRIMARY KEY, session_id INTEGER, channel_id INTEGER NOT NULL,
      station_id INTEGER, queue_id INTEGER, queue_start_time INTEGER,
      effective_at INTEGER NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE sh_queue_revision_items (
      revision_id INTEGER NOT NULL, position INTEGER NOT NULL,
      queue_track_id INTEGER, stationhead_track_id INTEGER, spotify_id TEXT,
      deezer_id TEXT, isrc TEXT, duration_ms INTEGER, bite_count INTEGER,
      PRIMARY KEY(revision_id,position)
    );
    CREATE TABLE sh_track_counter_changes (
      id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL,
      occurrence_key TEXT NOT NULL, count_value INTEGER NOT NULL
    );
    CREATE TABLE sh_broadcast_sessions (
      id INTEGER PRIMARY KEY, station_id INTEGER
    );
    CREATE TABLE sh_minute_facts (
      id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, is_paused INTEGER,
      broadcast_session_id INTEGER
    );
    CREATE TABLE sh_minute_fact_context (
      fact_id INTEGER PRIMARY KEY, station_id INTEGER, queue_id INTEGER,
      queue_start_time INTEGER, queue_available INTEGER NOT NULL
    );
    CREATE TABLE sh_minute_fact_context_v2 (
      fact_id INTEGER PRIMARY KEY, station_id_override INTEGER,
      queue_revision_id INTEGER, queue_available INTEGER NOT NULL
    );
    CREATE VIEW sh_queue_items AS SELECT NULL AS id;
    CREATE VIEW sh_queue_snapshots AS SELECT NULL AS id;
  `);
  db.exec(repairMigration);
  db.exec(compactMigration);
  return db;
}

function revision(db, id, start, effectiveAt, tracks, status = 'complete') {
  db.prepare(`INSERT INTO sh_queue_revisions VALUES (?,1,318,3328626,99,?,?,?)`)
    .run(id, start, effectiveAt, status);
  const insert = db.prepare(`INSERT INTO sh_queue_revision_items VALUES (?,?,?,?,?,?,?,?,?)`);
  tracks.forEach((spotifyId, position) => insert.run(
    id, position, id * 100 + position, 1000 + position,
    spotifyId, null, `ISRC-${spotifyId}`, 120000, position,
  ));
}

test('latest complete queue revision is exposed once without a global window rank', () => {
  const db = database();
  const start = Date.parse('2026-07-15T00:00:00Z');
  revision(db, 1, start, start, ['a', 'b']);
  revision(db, 2, start, start + 60000, ['a', 'b', 'c']);
  revision(db, 3, start, start + 120000, ['a', 'b', 'pending'], 'pending');

  const rows = db.prepare('SELECT id,spotify_id FROM sh_queue_items ORDER BY position').all();
  assert.deepEqual(rows.map((row) => row.spotify_id), ['a', 'b', 'c']);
  assert.ok(rows.every((row) => Math.trunc(row.id / 1000000) === 2));
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT spotify_id FROM sh_queue_items
    WHERE start_time>=? AND start_time<?`).all(start, start + 1);
  assert.match(plan.map((row) => row.detail).join('\n'), /idx_sh_queue_revisions_track_history_latest/);
});

test('queue snapshots use sparse normalized context and preserve pause states', () => {
  const db = database();
  const start = Date.parse('2026-07-15T00:00:00Z');
  revision(db, 1, start, start, ['a']);
  db.prepare('INSERT INTO sh_broadcast_sessions VALUES (?,?)').run(1, 3328626);
  const fact = db.prepare('INSERT INTO sh_minute_facts VALUES (?,?,?,1)');
  const legacy = db.prepare('INSERT INTO sh_minute_fact_context VALUES (?,3328626,99,?,1)');
  const compact = db.prepare('INSERT INTO sh_minute_fact_context_v2 VALUES (?,NULL,1,1)');
  for (const [id, offset, paused] of [[1, 0, 0], [2, 300000, 1], [3, 900000, 0]]) {
    fact.run(id, start + offset, paused);
    legacy.run(id, start);
    compact.run(id);
  }

  const rows = db.prepare('SELECT observed_at,is_paused FROM sh_queue_snapshots ORDER BY observed_at').all();
  assert.deepEqual(rows.map((row) => row.is_paused), [0, 1, 0]);
});
