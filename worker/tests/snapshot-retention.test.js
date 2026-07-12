import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pruneOldSnapshots,
  pruneOldSnapshotsSafely,
  shouldRunSnapshotRetention,
  snapshotRetentionEnabled,
} from '../src/snapshot-retention.js';

function fakeDb({ stateRow = null, deleteBatches = {} } = {}) {
  const calls = [];
  const remaining = { ...deleteBatches };
  return {
    calls,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              calls.push({ kind: 'first', sql, params });
              return stateRow;
            },
            async run() {
              calls.push({ kind: 'run', sql, params });
              if (sql.startsWith('INSERT INTO sh_data_maintenance_state')) {
                return { meta: { changes: 1 } };
              }
              const table = sql.match(/DELETE FROM (\w+)/)?.[1];
              const queue = remaining[table] || [];
              const changes = queue.length ? queue.shift() : 0;
              return { meta: { changes } };
            },
          };
        },
      };
    },
  };
}

test('snapshotRetentionEnabled defaults to true and honors explicit disable', () => {
  assert.equal(snapshotRetentionEnabled({}), true);
  assert.equal(snapshotRetentionEnabled({ SNAPSHOT_RETENTION_ENABLED: 'false' }), false);
  assert.equal(snapshotRetentionEnabled({ SNAPSHOT_RETENTION_ENABLED: 'true' }), true);
});

test('shouldRunSnapshotRetention gates on the configured interval', () => {
  assert.equal(shouldRunSnapshotRetention(0, 60 * 60_000, {}), true);
  assert.equal(shouldRunSnapshotRetention(60 * 60_000 - 1, 2 * 60 * 60_000, {}), true);
  assert.equal(shouldRunSnapshotRetention(59 * 60_000, 60 * 60_000, {}), false);
});

test('pruneOldSnapshots skips when the DB binding is missing', async () => {
  assert.deepEqual(await pruneOldSnapshots({}), { skipped: true, reason: 'db-binding-missing' });
});

test('pruneOldSnapshots skips when disabled', async () => {
  const db = fakeDb();
  assert.deepEqual(
    await pruneOldSnapshots({ DB: db, SNAPSHOT_RETENTION_ENABLED: 'false' }),
    { skipped: true, reason: 'disabled' },
  );
  assert.equal(db.calls.length, 0);
});

test('pruneOldSnapshots skips when the last cleanup was recent', async () => {
  const now = 10 * 60 * 60_000;
  const db = fakeDb({ stateRow: { last_cleanup_at: now - 5 * 60_000 } });
  const result = await pruneOldSnapshots({ DB: db }, now);
  assert.deepEqual(result, { skipped: true, reason: 'not-due' });
});

test('pruneOldSnapshots deletes old rows from both snapshot tables and records state', async () => {
  const now = 10 * 60 * 60_000;
  const db = fakeDb({
    stateRow: null,
    deleteBatches: {
      sh_channel_snapshots: [200],
      sh_queue_snapshots: [50],
    },
  });

  const result = await pruneOldSnapshots({ DB: db, SNAPSHOT_RETENTION_BATCH_SIZE: 1000 }, now);

  assert.equal(result.skipped, false);
  assert.equal(result.cutoff, now - 30 * 24 * 60 * 60_000);
  assert.deepEqual(result.deleted, { sh_channel_snapshots: 200, sh_queue_snapshots: 50 });

  const stateWrite = db.calls.find((call) => call.sql.startsWith('INSERT INTO sh_data_maintenance_state'));
  assert.ok(stateWrite);
  assert.deepEqual(stateWrite.params, ['snapshot-retention-v1', now, now]);
});

test('pruneOldSnapshots loops per table until a batch comes back short of the limit', async () => {
  const now = 10 * 60 * 60_000;
  const db = fakeDb({
    stateRow: null,
    deleteBatches: {
      sh_channel_snapshots: [100, 100, 30],
      sh_queue_snapshots: [0],
    },
  });

  const result = await pruneOldSnapshots({ DB: db, SNAPSHOT_RETENTION_BATCH_SIZE: 100 }, now);

  assert.equal(result.deleted.sh_channel_snapshots, 230);
  assert.equal(result.deleted.sh_queue_snapshots, 0);
  const channelDeletes = db.calls.filter((call) => call.sql.includes('DELETE FROM sh_channel_snapshots'));
  assert.equal(channelDeletes.length, 3);
  const queueDeletes = db.calls.filter((call) => call.sql.includes('DELETE FROM sh_queue_snapshots'));
  assert.equal(queueDeletes.length, 1);
});

test('pruneOldSnapshots stops after the configured max batches even if rows remain', async () => {
  const now = 10 * 60 * 60_000;
  const db = fakeDb({
    stateRow: null,
    deleteBatches: {
      sh_channel_snapshots: [100, 100, 100, 100],
      sh_queue_snapshots: [],
    },
  });

  const result = await pruneOldSnapshots({
    DB: db,
    SNAPSHOT_RETENTION_BATCH_SIZE: 100,
    SNAPSHOT_RETENTION_MAX_BATCHES: 2,
  }, now);

  assert.equal(result.deleted.sh_channel_snapshots, 200);
  const channelDeletes = db.calls.filter((call) => call.sql.includes('DELETE FROM sh_channel_snapshots'));
  assert.equal(channelDeletes.length, 2);
});

test('pruneOldSnapshotsSafely reports errors instead of throwing', async () => {
  const db = {
    prepare() {
      throw new Error('boom');
    },
  };
  const result = await pruneOldSnapshotsSafely({ DB: db });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'retention-error');
  assert.match(result.error, /boom/);
});
