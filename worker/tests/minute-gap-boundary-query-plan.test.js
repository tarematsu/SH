import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { PREVIOUS_GAP_SNAPSHOT_SQL } from '../src/minute-facts-gap-scan.js';

test('gap reconstruction seeks one previous snapshot inside its channel', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_channel_snapshots(
      id INTEGER PRIMARY KEY,observed_at INTEGER,channel_id INTEGER,channel_alias TEXT,
      channel_name TEXT,station_id INTEGER,is_launched INTEGER,is_broadcasting INTEGER,
      chat_status TEXT,listener_count INTEGER,online_member_count INTEGER,total_member_count INTEGER,
      guest_count INTEGER,total_listens INTEGER,stream_goal INTEGER,current_stream_count INTEGER,
      host_account_id INTEGER,host_handle TEXT,broadcast_start_time INTEGER
    );
    CREATE INDEX idx_sh_channel_snapshots_channel_time_id
      ON sh_channel_snapshots(channel_id,observed_at DESC,id DESC);
  `);

  const plan = db.prepare(`EXPLAIN QUERY PLAN ${PREVIOUS_GAP_SNAPSHOT_SQL}`)
    .all(1, 1000)
    .map(({ detail }) => String(detail));
  assert.ok(
    plan.some((detail) => detail.includes(
      'idx_sh_channel_snapshots_channel_time_id (channel_id=? AND observed_at<?)',
    )),
    `expected a channel-local boundary seek: ${plan.join(' | ')}`,
  );
  assert.ok(
    plan.every((detail) => !detail.includes('USE TEMP B-TREE')),
    `boundary seek unexpectedly sorts history: ${plan.join(' | ')}`,
  );
  db.close();
});
