import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resetSnapshotHashCacheForTests,
  saveLeanSnapshot,
} from '../functions/lib/d1-lean-ingest.js';

function snapshotDb() {
  let current = null;
  const batches = [];
  return {
    batches,
    prepare(sql) {
      const statement = {
        sql,
        params: [],
        bind(...params) {
          statement.params = params;
          return statement;
        },
        async first() {
          if (sql.includes('FROM sh_snapshot_current')) return current;
          throw new Error(`unexpected first: ${sql}`);
        },
      };
      return statement;
    },
    async batch(statements) {
      batches.push(statements);
      const currentStatement = statements.find((statement) => statement.sql.includes('INSERT INTO sh_snapshot_current'));
      if (currentStatement) {
        current = {
          payload_hash: currentStatement.params[1],
          last_snapshot_at: currentStatement.params[2],
        };
      }
      return statements.map(() => ({ success: true }));
    },
  };
}

test('snapshot cache hits compare primitive signatures without rebuilding canonical JSON', async () => {
  resetSnapshotHashCacheForTests();
  const db = snapshotDb();
  const data = {
    channel_id: 1,
    station_id: 2,
    channel_alias: 'buddies',
    is_launched: true,
    is_broadcasting: true,
    listener_count: 10,
    current_stream_count: 4,
    presentation: {
      description: 'Buddies',
      images: { medium: { url: 'https://example.com/channel.jpg' } },
    },
  };

  await saveLeanSnapshot(db, 1_700_000_000_000, data);
  assert.equal(db.batches.length, 1);

  const originalStringify = JSON.stringify;
  let stringifyCalls = 0;
  JSON.stringify = (...args) => {
    stringifyCalls += 1;
    return originalStringify(...args);
  };
  try {
    const unchanged = await saveLeanSnapshot(db, 1_700_000_060_000, data);
    assert.equal(unchanged.skipped, true);
    assert.equal(stringifyCalls, 0);

    await saveLeanSnapshot(db, 1_700_000_120_000, { ...data, listener_count: 11 });
    assert.ok(stringifyCalls > 0);
  } finally {
    JSON.stringify = originalStringify;
    resetSnapshotHashCacheForTests();
  }
});
