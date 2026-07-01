import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  HISTORY_24H_SQL,
  PREDICTION_24H_SQL,
  linearRegressionPrediction,
  linearRegressionPredictionFromAggregate,
  cachedHostMetric,
  resetHostMetricCache,
} from '../site/functions/api/dashboard.js';

function createSnapshotsDb() {
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
  return db;
}

test('dashboard history keeps latest values and maximum comment velocity per bucket', () => {
  const db = createSnapshotsDb();
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

test('aggregate prediction matches row-based regression without returning 24 hours of rows', () => {
  const db = createSnapshotsDb();
  const base = Math.floor((Date.now() - 30 * 60000) / 300000) * 300000;
  const insert = db.prepare(`INSERT INTO sh_channel_snapshots VALUES (?,?,?,?,?,?,?,?,?)`);
  for (let index = 0; index < 5; index += 1) {
    insert.run(index + 1, base + index * 300000 + 1000, null, null, null, null, 100 + index * 5, 180, null);
  }
  const rows = db.prepare(HISTORY_24H_SQL).all();
  const aggregate = db.prepare(PREDICTION_24H_SQL).get();
  const now = rows.at(-1).observed_at;
  const fromRows = linearRegressionPrediction(rows, 180, now);
  const fromAggregate = linearRegressionPredictionFromAggregate(aggregate, 180, now);

  assert.ok(fromRows);
  assert.ok(fromAggregate);
  assert.equal(fromAggregate.sample_count, 5);
  assert.ok(Math.abs(fromAggregate.rate_per_hour - 60) < 1e-8);
  assert.ok(Math.abs(fromAggregate.rate_per_hour - fromRows.rate_per_hour) < 1e-8);
  assert.ok(Math.abs(fromAggregate.eta - fromRows.eta) < 1);
});

test('dashboard baseline requests share and reuse the same host/day query', async () => {
  resetHostMetricCache();
  let calls = 0;
  const db = {
    prepare(sql) {
      assert.match(sql, /total_member_count/);
      return {
        bind(...values) {
          assert.deepEqual(values, [1000, 2000, 42]);
          return {
            async first() {
              calls += 1;
              await new Promise((resolve) => setTimeout(resolve, 5));
              return { observed_at: 1900, total_member_count: 123 };
            },
          };
        },
      };
    },
  };
  const scope = { column: 'host_account_id', value: 42 };
  const [first, second] = await Promise.all([
    cachedHostMetric(db, 'total_member_count', scope, 1000, 2000),
    cachedHostMetric(db, 'total_member_count', scope, 1000, 2000),
  ]);

  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal((await cachedHostMetric(db, 'total_member_count', scope, 1000, 2000)).total_member_count, 123);
  assert.equal(calls, 1);
});
