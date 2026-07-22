import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { FACTS_LATEST_SQL } from '../site/functions/lib/dashboard-facts.js';

test('latest facts query seeks one fact and a channel-local comment range', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_minute_facts(
      id INTEGER PRIMARY KEY, minute_at INTEGER, observed_at INTEGER, channel_id INTEGER,
      is_broadcasting INTEGER, listener_count INTEGER, online_member_count INTEGER,
      total_member_count INTEGER, guest_count INTEGER, reported_total_listens INTEGER,
      reported_current_stream_count INTEGER, is_paused INTEGER, comment_count INTEGER,
      source_code INTEGER, broadcast_session_id INTEGER
    );
    CREATE INDEX idx_sh_minute_facts_live_minute
      ON sh_minute_facts(source_code,minute_at DESC,id DESC,channel_id,observed_at,is_broadcasting);
    CREATE INDEX idx_sh_minute_facts_source_channel_minute_desc
      ON sh_minute_facts(source_code,channel_id,minute_at DESC,id DESC);
    CREATE TABLE sh_total_member_daily(
      channel_id INTEGER,day_at INTEGER,host_key INTEGER,last_observed_at INTEGER,
      last_total_member_count INTEGER,PRIMARY KEY(channel_id,day_at,host_key)
    );
    CREATE TABLE sh_minute_fact_context_v2(
      fact_id INTEGER PRIMARY KEY,station_id_override INTEGER,host_id_override INTEGER,
      broadcast_start_time_override INTEGER,queue_revision_id INTEGER,queue_available INTEGER
    );
    CREATE TABLE sh_broadcast_sessions(
      id INTEGER PRIMARY KEY,station_id INTEGER,host_id INTEGER,broadcast_start_time INTEGER
    );
    CREATE TABLE sh_queue_revisions(
      id INTEGER PRIMARY KEY,queue_id INTEGER,queue_start_time INTEGER,item_count INTEGER
    );
    CREATE TABLE sh_hosts(id INTEGER PRIMARY KEY,stationhead_account_id INTEGER,current_handle TEXT);
  `);

  const details = db.prepare(`EXPLAIN QUERY PLAN ${FACTS_LATEST_SQL}`).all()
    .map((row) => String(row.detail));
  assert.ok(details.some((line) => line.includes('idx_sh_minute_facts_live_minute (source_code=?)')));
  assert.ok(details.some((line) => line.includes(
    'idx_sh_minute_facts_source_channel_minute_desc (source_code=? AND channel_id=? AND minute_at>? AND minute_at<?)',
  )));
  assert.ok(details.some((line) => line.includes('SEARCH v USING INTEGER PRIMARY KEY')));
  assert.ok(!details.some((line) => line.includes('MATERIALIZE sh_minute_fact_context')));
  db.close();
});
