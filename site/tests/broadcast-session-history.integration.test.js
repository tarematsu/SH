import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  BROADCAST_SUMMARY_SQL,
  parseBroadcastSummaryRows,
} from '../functions/api/history.js';

test('broadcast history reads the compact official summary table', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sh_official_broadcast_summary (
    host_handle TEXT NOT NULL,
    event_name TEXT NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    started_jst TEXT,
    ended_jst TEXT,
    sample_count INTEGER NOT NULL DEFAULT 0,
    listener_avg REAL,
    listener_max INTEGER,
    likes_max INTEGER,
    distinct_tracks INTEGER,
    PRIMARY KEY(host_handle,event_name)
  )`);
  db.prepare(`INSERT INTO sh_official_broadcast_summary VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    'sakurazaka46jp', 'Event A', 1000, 2000, '2025-01-01 09:00:01',
    '2025-01-01 09:00:02', 2, 110, 120, 12, 2,
  );

  const rows = db.prepare(BROADCAST_SUMMARY_SQL).all(0, 3000, 0, 3000);
  const parsed = parseBroadcastSummaryRows(rows);

  assert.equal(parsed.setupRequired, false);
  assert.deepEqual(parsed.rows, [{
    event_name: 'Event A',
    started_at: 1000,
    ended_at: 2000,
    started_jst: '2025-01-01 09:00:01',
    ended_jst: '2025-01-01 09:00:02',
    sample_count: 2,
    listener_avg: 110,
    listener_max: 120,
    likes_max: 12,
    distinct_tracks: 2,
    host_handle: 'sakurazaka46jp',
  }]);
});

test('an empty range reports whether the compact summary is provisioned', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sh_official_broadcast_summary (
    host_handle TEXT NOT NULL,event_name TEXT NOT NULL,started_at INTEGER,
    ended_at INTEGER,started_jst TEXT,ended_jst TEXT,sample_count INTEGER,
    listener_avg REAL,listener_max INTEGER,likes_max INTEGER,distinct_tracks INTEGER,
    PRIMARY KEY(host_handle,event_name)
  )`);
  const parsed = parseBroadcastSummaryRows(db.prepare(BROADCAST_SUMMARY_SQL).all(0, 100, 0, 100));
  assert.deepEqual(parsed.rows, []);
  assert.equal(parsed.setupRequired, true);
});
