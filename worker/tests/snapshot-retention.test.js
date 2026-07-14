import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pruneOldSnapshots,
  pruneOldSnapshotsSafely,
  shouldRunSnapshotRetention,
  snapshotRetentionEnabled,
} from '../src/snapshot-retention.js';

test('snapshotRetentionEnabled defaults to true and honors explicit disable', () => {
  assert.equal(snapshotRetentionEnabled({}), true);
  assert.equal(snapshotRetentionEnabled({ SNAPSHOT_RETENTION_ENABLED: 'false' }), false);
});

test('shouldRunSnapshotRetention preserves the former interval calculation', () => {
  assert.equal(shouldRunSnapshotRetention(0, 3_600_000, {}), true);
  assert.equal(shouldRunSnapshotRetention(3_500_000, 3_600_000, {}), false);
});

test('other always skips archive snapshot retention without touching a D1 binding', async () => {
  const trap = new Proxy({}, { get() { throw new Error('archive DB must not be touched'); } });
  assert.deepEqual(
    await pruneOldSnapshots({ DB: trap, FACTS_DB: trap, OTHER_DB: trap }),
    { skipped: true, reason: 'archive-retention-disabled' },
  );
  assert.deepEqual(
    await pruneOldSnapshotsSafely({}),
    { skipped: true, reason: 'archive-retention-disabled' },
  );
});

test('explicit retention disable remains distinguishable', async () => {
  assert.deepEqual(
    await pruneOldSnapshots({ SNAPSHOT_RETENTION_ENABLED: '0' }),
    { skipped: true, reason: 'disabled' },
  );
});
