import assert from 'node:assert/strict';
import test from 'node:test';

import { runDispatchedPagesReadModelTask } from '../src/pages-read-model-dispatch.js';
import {
  materializeTrackHistoryRangeThroughR2,
  trackHistoryDayShardRanges,
} from '../src/pages-track-history-r2-shards.js';

const DAY_START = Date.UTC(2026, 6, 23);

class FakeR2 {
  constructor() {
    this.values = new Map();
    this.puts = 0;
    this.gets = 0;
  }

  async put(key, value) {
    this.puts += 1;
    this.values.set(key, String(value));
  }

  async get(key) {
    this.gets += 1;
    const value = this.values.get(key);
    if (value == null) return null;
    return { async json() { return JSON.parse(value); } };
  }
}

class FakeDb {
  constructor() {
    this.batches = [];
    this.deletes = [];
  }

  prepare(sql) {
    const statement = {
      sql,
      args: [],
      bind(...args) {
        this.args = args;
        return this;
      },
      run: async () => {
        this.deletes.push(statement);
        return { meta: { changes: 1 } };
      },
    };
    statement.deletes = this.deletes;
    return statement;
  }

  async batch(statements) {
    this.batches.push(statements);
    return statements.map(() => ({ success: true }));
  }
}

function merged(rows) {
  if (!rows.length) return [];
  return [{
    ...rows[0],
    play_count: rows.reduce((sum, row) => sum + Number(row.play_count || 0), 0),
    first_played_at: Math.min(...rows.map((row) => Number(row.first_played_at))),
    last_played_at: Math.max(...rows.map((row) => Number(row.last_played_at))),
  }];
}

function dependencies(range) {
  return {
    async loadData(db) {
      assert.ok(db?.prepare, 'compact MINUTE_DB must be used as the source');
      return {
        result: {
          results: [{
            play_date: '2026-07-23',
            spotify_id: 'track-1',
            title: 'Track 1',
            artist: 'Artist',
            play_count: 1,
            first_played_at: range.fromTs,
            last_played_at: range.toTs - 1,
          }],
        },
        likeRows: [],
      };
    },
    mergeRows: merged,
    attachLikes: (rows) => rows,
    applyCompleteness: (rows) => ({ rows, excludedDates: [] }),
  };
}

test('track-history aliases BUDDIES_DB to compact MINUTE_DB before running a shard', async () => {
  const minuteDb = {};
  let observedEnv;
  await runDispatchedPagesReadModelTask({
    MINUTE_DB: minuteDb,
    PAGES_RESPONSE_R2: new FakeR2(),
  }, DAY_START, {
    async runTrackHistoryStep(env) {
      observedEnv = env;
      return { skipped: true };
    },
  });
  assert.equal(observedEnv.MINUTE_DB, minuteDb);
  assert.equal(observedEnv.BUDDIES_DB, minuteDb);
});

test('seven shards stay in R2 and only the final shard rewrites the canonical day', async () => {
  const r2 = new FakeR2();
  const db = new FakeDb();
  const ranges = trackHistoryDayShardRanges({ fromTs: DAY_START, toTs: DAY_START + 3 * 60 * 60_000 });
  assert.equal(ranges.length, 8);

  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    const result = await materializeTrackHistoryRangeThroughR2(
      { prepare() { throw new Error('raw BUDDIES_DB must not be read'); } },
      db,
      range,
      DAY_START + index,
      {
        ...dependencies(range),
        r2,
        generation: DAY_START,
        cleanupDay: index === ranges.length - 1,
      },
    );
    if (index < ranges.length - 1) {
      assert.equal(result.storage, 'r2-shard');
      assert.equal(db.batches.length, 0);
    } else {
      assert.equal(result.storage, 'd1-day');
      assert.equal(result.rows, 1);
      assert.equal(result.stagedRows, 8);
    }
  }

  assert.equal(r2.puts, 8);
  assert.equal(r2.gets, 8);
  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0].length, 1);
  assert.equal(db.deletes.length, 1);
});
