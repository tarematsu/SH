import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { HISTORY_24H_SQL } from '../site/functions/api/dashboard.js';

test('dashboard history keeps latest values and maximum comment velocity per bucket', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_channel_snapshots (
      id INTEGER PRIMARY KEY,
      observed_at INTEGER NOT NULL,
      listener_count INTEGER,
      online_member_count INTEGER,
      total_member_count INTEGER,
      total_listens INTEGER,
      current_stream_count INTEGER,
      stream_goal INTEGER,
      comment_velocity INTEGER
    );
  `);
  const now = Date.now();
  const bucket = Math.floor(now / 300000) * 300000;
  const insert = db.prepare(`INSERT INTO sh_channel_snapshots VALUES (?,?,?,?,?,?,?,?,?)`);
  insert.run(1, bucket + 1000, 10, 20, 30, 40, 50, 60, 25);
  insert.run(2, bucket + 2000, 11, 21, 31, 41, 51, 61, 3);

  const rows = db.prepare(HISTORY_24H_SQL).all();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].listener_count, 11);
  assert.equal(rows[0].comment_velocity, 25);
});
