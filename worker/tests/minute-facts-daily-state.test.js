import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  TOTAL_MEMBER_DAILY_CHECKPOINT_MS,
  totalMemberDailyCheckpointStatement,
} from '../src/minute-facts-daily-state.js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE sh_total_member_daily(
    channel_id INTEGER NOT NULL,
    day_at INTEGER NOT NULL,
    host_key INTEGER NOT NULL DEFAULT 0,
    host_id INTEGER,
    first_observed_at INTEGER NOT NULL,
    last_observed_at INTEGER NOT NULL,
    first_total_member_count INTEGER NOT NULL,
    last_total_member_count INTEGER NOT NULL,
    min_total_member_count INTEGER NOT NULL,
    max_total_member_count INTEGER NOT NULL,
    source_code INTEGER NOT NULL,
    source_priority INTEGER NOT NULL,
    quality_score_code INTEGER NOT NULL DEFAULT 100,
    PRIMARY KEY(channel_id,day_at,host_key)
  );`);
  return sqlite;
}

function d1Adapter(sqlite) {
  return {
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
        async run() {
          const result = statement.run();
          return { meta: { changes: Number(result.changes || 0) } };
        },
      };
    },
  };
}

function fact(observedAt, count) {
  return {
    channel_id: 318,
    observed_at: observedAt,
    total_member_count: count,
    host_id: 12,
    source_code: 1,
    source_priority: 100,
    quality_score: 1,
  };
}

test('unchanged total-member state writes only at the twenty-minute checkpoint', async () => {
  const sqlite = database();
  const db = d1Adapter(sqlite);
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);

  const inserted = await totalMemberDailyCheckpointStatement(db, fact(start, 100)).run();
  const unchanged = await totalMemberDailyCheckpointStatement(db, fact(start + 60_000, 100)).run();
  const changed = await totalMemberDailyCheckpointStatement(db, fact(start + 2 * 60_000, 101)).run();
  const beforeCheckpoint = await totalMemberDailyCheckpointStatement(
    db,
    fact(start + 2 * 60_000 + TOTAL_MEMBER_DAILY_CHECKPOINT_MS - 1, 101),
  ).run();
  const checkpoint = await totalMemberDailyCheckpointStatement(
    db,
    fact(start + 2 * 60_000 + TOTAL_MEMBER_DAILY_CHECKPOINT_MS, 101),
  ).run();

  assert.equal(inserted.meta.changes, 1);
  assert.equal(unchanged.meta.changes, 0);
  assert.equal(changed.meta.changes, 1);
  assert.equal(beforeCheckpoint.meta.changes, 0);
  assert.equal(checkpoint.meta.changes, 1);

  const row = sqlite.prepare(`SELECT last_observed_at,last_total_member_count,
    min_total_member_count,max_total_member_count FROM sh_total_member_daily`).get();
  assert.equal(row.last_observed_at, start + 2 * 60_000 + TOTAL_MEMBER_DAILY_CHECKPOINT_MS);
  assert.equal(row.last_total_member_count, 101);
  assert.equal(row.min_total_member_count, 100);
  assert.equal(row.max_total_member_count, 101);
});

test('missing total-member values remain a no-op', async () => {
  const sqlite = database();
  const db = d1Adapter(sqlite);
  const result = await totalMemberDailyCheckpointStatement(db, fact(Date.now(), null)).run();
  assert.equal(result.meta.changes, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM sh_total_member_daily').get().count, 0);
});
