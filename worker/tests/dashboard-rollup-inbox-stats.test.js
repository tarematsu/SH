import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  FACTS_HISTORY_24H_SQL,
  FACTS_PREDICTION_24H_SQL,
} from '../../site/functions/lib/dashboard-facts.js';
import { dashboardHistoryRollupStatement } from '../src/minute-facts-statement-plan.js';
import {
  MINUTE_FACT_INBOX_STATS_SQL,
  minuteFactInboxStats,
} from '../src/minute-facts-inbox.js';

const migration = readFileSync(
  new URL('../../database/facts-migrations/034_dashboard_rollup_inbox_stats.sql', import.meta.url),
  'utf8',
);

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE sh_minute_facts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      minute_at INTEGER NOT NULL,
      observed_at INTEGER NOT NULL,
      source_code INTEGER NOT NULL,
      listener_count INTEGER,
      online_member_count INTEGER,
      total_member_count INTEGER,
      reported_total_listens INTEGER,
      reported_current_stream_count INTEGER,
      comment_count INTEGER
    );
    CREATE INDEX idx_sh_minute_facts_source_channel_minute_desc
      ON sh_minute_facts(source_code,channel_id,minute_at DESC,id DESC);
    CREATE TABLE sh_total_member_daily(
      channel_id INTEGER NOT NULL,
      day_at INTEGER NOT NULL,
      host_key INTEGER NOT NULL,
      last_observed_at INTEGER NOT NULL,
      last_total_member_count INTEGER
    );
    CREATE TABLE sh_minute_fact_jobs(
      id INTEGER PRIMARY KEY,
      minute_at INTEGER NOT NULL,
      job_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );`);
  sqlite.exec(migration);
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
            async first() { return statement.get(...params) || null; },
            async all() { return { results: statement.all(...params) }; },
          };
        },
        async first() { return statement.get() || null; },
        async all() { return { results: statement.all() }; },
      };
    },
  };
}

function insertFact(sqlite, values) {
  sqlite.prepare(`INSERT INTO sh_minute_facts(
      channel_id,minute_at,observed_at,source_code,listener_count,
      online_member_count,total_member_count,reported_total_listens,
      reported_current_stream_count,comment_count
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(...values);
}

test('five-minute rollup keeps the latest fact and maximum one-minute comment velocity', async () => {
  const sqlite = database();
  const db = d1Adapter(sqlite);
  const now = Date.now();
  const bucket = Math.floor(now / 300_000) * 300_000;
  insertFact(sqlite, [318, bucket, bucket + 1_000, 1, 10, 20, 30, 40, 100, 5]);
  await dashboardHistoryRollupStatement(db, {
    source_code: 1,
    channel_id: 318,
    minute_at: bucket,
  }).run();
  insertFact(sqlite, [318, bucket + 60_000, bucket + 61_000, 1, 11, 21, 31, 41, 105, 7]);
  await dashboardHistoryRollupStatement(db, {
    source_code: 1,
    channel_id: 318,
    minute_at: bucket + 60_000,
  }).run();

  const rows = sqlite.prepare(FACTS_HISTORY_24H_SQL).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].listener_count, 11);
  assert.equal(rows[0].total_listens, 41);
  assert.equal(rows[0].comment_velocity, 12);
  assert.doesNotMatch(FACTS_HISTORY_24H_SQL, /FROM sh_minute_facts AS f\s+WHERE f\.source_code=1[\s\S]*RANGE BETWEEN/);
  assert.match(FACTS_HISTORY_24H_SQL, /FROM sh_dashboard_history_5m r/);
});

test('24-hour prediction aggregate reads the rollup rather than raw minute facts', async () => {
  const sqlite = database();
  const db = d1Adapter(sqlite);
  const base = Math.floor((Date.now() - 30 * 60_000) / 300_000) * 300_000;
  for (let index = 0; index < 5; index += 1) {
    const minuteAt = base + index * 300_000;
    insertFact(sqlite, [318, minuteAt, minuteAt + 1_000, 1, null, null, null, null, 100 + index * 5, 0]);
    await dashboardHistoryRollupStatement(db, {
      source_code: 1,
      channel_id: 318,
      minute_at: minuteAt,
    }).run();
  }

  const aggregate = sqlite.prepare(FACTS_PREDICTION_24H_SQL).get();
  assert.equal(aggregate.sample_count, 5);
  assert.match(FACTS_PREDICTION_24H_SQL, /FROM sh_dashboard_history_5m r/);
  assert.doesNotMatch(FACTS_PREDICTION_24H_SQL, /FROM sh_minute_facts\s+WHERE source_code=1[\s\S]*reported_current_stream_count/);
});

test('persisted inbox counters follow insert, claim, completion, retry, and deletion transitions', async () => {
  const sqlite = database();
  const db = d1Adapter(sqlite);
  const insert = sqlite.prepare(`INSERT INTO sh_minute_fact_jobs(
    id,minute_at,job_kind,status,updated_at
  ) VALUES(?,?,?,?,?)`);
  insert.run(1, 100, 'live', 'pending', 1000);
  insert.run(2, 50, 'rebuild', 'pending', 1000);
  insert.run(3, 200, 'live', 'dead', 1000);

  let stats = await minuteFactInboxStats({ MINUTE_DB: db });
  assert.deepEqual(stats, {
    pending_count: 2,
    processing_count: 0,
    dead_count: 1,
    rebuild_pending_count: 1,
    live_pending_count: 1,
    oldest_pending_minute: 50,
  });

  sqlite.exec("UPDATE sh_minute_fact_jobs SET status='processing',updated_at=1100 WHERE id=2;");
  stats = await minuteFactInboxStats({ MINUTE_DB: db });
  assert.equal(stats.pending_count, 1);
  assert.equal(stats.processing_count, 1);
  assert.equal(stats.rebuild_pending_count, 0);
  assert.equal(stats.oldest_pending_minute, 100);

  sqlite.exec("UPDATE sh_minute_fact_jobs SET status='pending',updated_at=1200 WHERE id=2;");
  sqlite.exec('DELETE FROM sh_minute_fact_jobs WHERE id=2;');
  stats = await minuteFactInboxStats({ MINUTE_DB: db });
  assert.equal(stats.pending_count, 1);
  assert.equal(stats.processing_count, 0);
  assert.equal(stats.oldest_pending_minute, 100);
  assert.match(MINUTE_FACT_INBOX_STATS_SQL, /FROM sh_minute_fact_inbox_stats/);
  assert.doesNotMatch(MINUTE_FACT_INBOX_STATS_SQL, /COUNT\(\*\)|MIN\(minute_at\)/);
});
