import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  guardedMinuteFactContextUpsertStatement,
  guardedMinuteFactStatement,
} from '../src/minute-facts-write-guards.js';

function captureDb() {
  return {
    prepare(sql) {
      return {
        sql: String(sql),
        params: [],
        bind(...params) {
          this.params = params;
          return this;
        },
      };
    },
  };
}

function execute(db, statement) {
  return db.prepare(statement.sql).run(...statement.params);
}

function fact(overrides = {}) {
  return {
    channel_id: 318,
    minute_at: 1_700_000_100_000,
    observed_at: 1_700_000_101_000,
    received_at: 1_700_000_101_500,
    source_code: 1,
    source_priority: 100,
    source_record_id: null,
    collector_code: 1,
    broadcast_session_id: 12,
    station_id: 3328626,
    host_id: 8,
    broadcast_start_time: 1_700_000_000_000,
    is_broadcasting: 1,
    listener_count: 100,
    online_member_count: 25,
    total_member_count: 30_000,
    guest_count: 4,
    reported_total_listens: 800_000,
    reported_current_stream_count: 50_000_000,
    is_paused: 0,
    track_detection_code: 1,
    track_confidence_code: 90,
    schedule_valid: 1,
    comment_count: 2,
    comment_total: 10_000,
    comments_degraded: 0,
    quality_score_code: 100,
    quality_flags: 0,
    queue_revision_id: 44,
    queue_available: 1,
    queue_position: 3,
    ...overrides,
  };
}

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_minute_facts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      minute_at INTEGER NOT NULL,
      observed_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      source_code INTEGER NOT NULL,
      source_priority INTEGER NOT NULL,
      source_record_id TEXT,
      collector_code INTEGER NOT NULL,
      broadcast_session_id INTEGER,
      is_broadcasting INTEGER,
      listener_count INTEGER,
      online_member_count INTEGER,
      total_member_count INTEGER,
      guest_count INTEGER,
      reported_total_listens INTEGER,
      reported_current_stream_count INTEGER,
      is_paused INTEGER,
      track_detection_code INTEGER,
      track_confidence_code INTEGER,
      schedule_valid INTEGER,
      comment_count INTEGER,
      comment_total INTEGER,
      comments_degraded INTEGER,
      quality_score_code INTEGER,
      quality_flags INTEGER,
      UNIQUE(channel_id,minute_at)
    );
    CREATE TABLE sh_broadcast_sessions(
      id INTEGER PRIMARY KEY,
      station_id INTEGER,
      host_id INTEGER,
      broadcast_start_time INTEGER
    );
    CREATE TABLE sh_minute_fact_context_v2(
      fact_id INTEGER PRIMARY KEY,
      station_id_override INTEGER,
      host_id_override INTEGER,
      broadcast_start_time_override INTEGER,
      queue_revision_id INTEGER,
      queue_available INTEGER,
      queue_position INTEGER
    );
    INSERT INTO sh_broadcast_sessions VALUES(12,3328626,8,1700000000000);
  `);
  return db;
}

test('same-minute timestamp-only retries do not rewrite the fact row', () => {
  const sqlite = database();
  const first = guardedMinuteFactStatement(captureDb(), fact());
  assert.equal(execute(sqlite, first).changes, 1);

  const retry = guardedMinuteFactStatement(captureDb(), fact({
    observed_at: 1_700_000_102_000,
    received_at: 1_700_000_102_500,
  }));
  assert.equal(execute(sqlite, retry).changes, 0);
  assert.equal(sqlite.prepare('SELECT observed_at FROM sh_minute_facts').get().observed_at, 1_700_000_101_000);

  const changed = guardedMinuteFactStatement(captureDb(), fact({
    observed_at: 1_700_000_103_000,
    received_at: 1_700_000_103_500,
    listener_count: 101,
  }));
  assert.equal(execute(sqlite, changed).changes, 1);
  const row = sqlite.prepare('SELECT observed_at,listener_count FROM sh_minute_facts').get();
  assert.equal(row.observed_at, 1_700_000_103_000);
  assert.equal(row.listener_count, 101);
});

test('same context values do not rewrite the same fact context row', () => {
  const sqlite = database();
  execute(sqlite, guardedMinuteFactStatement(captureDb(), fact()));

  const first = guardedMinuteFactContextUpsertStatement(captureDb(), fact());
  assert.equal(execute(sqlite, first).changes, 1);

  const retry = guardedMinuteFactContextUpsertStatement(captureDb(), fact({
    observed_at: 1_700_000_102_000,
  }));
  assert.equal(execute(sqlite, retry).changes, 0);

  const changed = guardedMinuteFactContextUpsertStatement(captureDb(), fact({
    observed_at: 1_700_000_103_000,
    queue_position: 4,
  }));
  assert.equal(execute(sqlite, changed).changes, 1);
  assert.equal(
    sqlite.prepare('SELECT queue_position FROM sh_minute_fact_context_v2').get().queue_position,
    4,
  );
});
