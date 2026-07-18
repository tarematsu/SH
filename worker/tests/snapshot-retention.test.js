import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pruneOldSnapshots,
  pruneOldSnapshotsSafely,
  shouldRunSnapshotRetention,
  snapshotRetentionEnabled,
} from '../src/snapshot-retention.js';

class FakeDb {
  constructor(lastCleanupAt = 0, deleteChanges = [3, 2]) {
    this.lastCleanupAt = lastCleanupAt;
    this.deleteChanges = [...deleteChanges];
    this.calls = [];
    this.batchCalls = [];
  }

  prepare(sql) {
    this.calls.push(sql);
    return {
      bind: (...values) => ({
        first: async () => (sql.includes('last_cleanup_at') ? { last_cleanup_at: this.lastCleanupAt } : null),
        run: async () => {
          if (sql.startsWith('DELETE FROM')) return { meta: { changes: this.deleteChanges.shift() ?? 0 } };
          return { meta: { changes: 1 } };
        },
        values,
      }),
    };
  }

  async batch(statements) {
    this.batchCalls.push(statements.length);
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

test('snapshotRetentionEnabled defaults to true and honors explicit disable', () => {
  assert.equal(snapshotRetentionEnabled({}), true);
  assert.equal(snapshotRetentionEnabled({ SNAPSHOT_RETENTION_ENABLED: 'false' }), false);
});

test('shouldRunSnapshotRetention preserves the interval calculation', () => {
  assert.equal(shouldRunSnapshotRetention(0, 3_600_000, {}), true);
  assert.equal(shouldRunSnapshotRetention(3_500_000, 3_600_000, {}), false);
});

test('retention deletes old raw snapshots in one normal-path D1 batch', async () => {
  const db = new FakeDb();
  const result = await pruneOldSnapshots({
    BUDDIES_DB: db,
    DB: new Proxy({}, { get() { throw new Error('primary fallback must not be touched'); } }),
    SNAPSHOT_RETENTION_MS: 86_400_000,
    SNAPSHOT_RETENTION_BATCH_SIZE: 1000,
  }, 100_000_000);

  assert.deepEqual(result, {
    skipped: false,
    cutoff: 13_600_000,
    deleted: {
      sh_channel_snapshots: 3,
      sh_queue_snapshots: 2,
      sh_queue_items: 0,
      sh_track_like_observations: 0,
      sh_track_metadata: 0,
      sh_ingest_claims: 0,
      sh_ingest_conflicts: 0,
    },
  });
  assert.deepEqual(db.batchCalls, [7]);
  assert.equal(db.calls.filter((sql) => sql.startsWith('DELETE FROM')).length, 7);
  assert.equal(db.calls.filter((sql) => sql.includes('INSERT INTO sh_data_maintenance_state')).length, 1);
});

test('retention continues only tables that fill the previous batch', async () => {
  const db = new FakeDb(0, [100, 0, 0, 0, 0, 0, 0, 100, 50]);
  const result = await pruneOldSnapshots({
    BUDDIES_DB: db,
    SNAPSHOT_RETENTION_BATCH_SIZE: 100,
    SNAPSHOT_RETENTION_MAX_BATCHES: 5,
  }, 100_000_000);

  assert.equal(result.deleted.sh_channel_snapshots, 250);
  assert.deepEqual(db.batchCalls, [7, 1, 1]);
});

test('retention observes the cleanup interval', async () => {
  const db = new FakeDb(97_000_000);
  assert.deepEqual(
    await pruneOldSnapshots({ BUDDIES_DB: db }, 100_000_000),
    { skipped: true, reason: 'not-due' },
  );
  assert.equal(db.calls.filter((sql) => sql.startsWith('DELETE FROM')).length, 0);
  assert.deepEqual(db.batchCalls, []);
});

test('missing binding is reported safely', async () => {
  assert.deepEqual(
    await pruneOldSnapshotsSafely({}, 100_000_000),
    { skipped: true, reason: 'db-binding-missing' },
  );
});

test('explicit retention disable remains distinguishable', async () => {
  assert.deepEqual(
    await pruneOldSnapshots({ SNAPSHOT_RETENTION_ENABLED: '0' }),
    { skipped: true, reason: 'disabled' },
  );
});
