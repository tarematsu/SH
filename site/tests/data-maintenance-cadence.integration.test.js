import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resetDataMaintenanceRuntimeState,
  runDataMaintenance,
  runDataMaintenanceSafely,
} from '../functions/lib/data-maintenance.js';
import { FakeD1Database } from './helpers/fake-d1.js';

const HOUR_MS = 3_600_000;
const STATE_SELECT = /SELECT last_rollup_key,last_cleanup_at,legacy_backfill_id,updated_at/;

test('persistent maintenance cadence survives a fresh runtime', async () => {
  const now = Date.parse('2026-07-05T03:00:00Z');
  const db = new FakeD1Database()
    .route('first', STATE_SELECT, {
      last_rollup_key: '2026-07-04',
      last_cleanup_at: now - 1_000,
      legacy_backfill_id: 5_000,
      updated_at: now - 1_000,
    });
  resetDataMaintenanceRuntimeState(db);

  const result = await runDataMaintenance(db, now);

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'persistent-cadence');
  assert.equal(result.nextCheckAt, now - 1_000 + HOUR_MS);
  assert.equal(db.calls.length, 1);
  assert.equal(db.batches.length, 0);
});

test('a transient state read failure does not suppress the next maintenance attempt', async () => {
  const now = Date.parse('2026-07-05T03:00:00Z');
  let reads = 0;
  const db = new FakeD1Database()
    .route('first', STATE_SELECT, () => {
      reads += 1;
      if (reads === 1) throw new Error('temporary D1 failure');
      return {
        last_rollup_key: '2026-07-04',
        last_cleanup_at: now,
        legacy_backfill_id: 5_000,
        updated_at: now,
      };
    });
  resetDataMaintenanceRuntimeState(db);

  const originalError = console.error;
  console.error = () => {};
  try {
    const failed = await runDataMaintenanceSafely(db, now);
    const retried = await runDataMaintenanceSafely(db, now + 1);

    assert.equal(failed.reason, 'maintenance-error');
    assert.equal(retried.reason, 'persistent-cadence');
    assert.equal(reads, 2);
  } finally {
    console.error = originalError;
  }
});

test('backfill state cannot regress when an older maintenance run finishes late', async () => {
  const now = Date.parse('2026-07-05T03:00:00Z');
  const db = new FakeD1Database()
    .route('first', STATE_SELECT, {
      last_rollup_key: '2026-07-04',
      last_cleanup_at: now,
      legacy_backfill_id: 5_000,
      updated_at: now - HOUR_MS,
    })
    .route('first', /SELECT MAX\(id\) AS batch_end,COUNT\(\*\) AS batch_count/, {
      batch_end: 5_002,
      batch_count: 2,
    });
  resetDataMaintenanceRuntimeState(db);

  const result = await runDataMaintenance(db, now);

  assert.equal(result.skipped, false);
  assert.deepEqual(result.legacyBackfill, {
    lastLegacyId: 5_002,
    migrated: 2,
    complete: false,
  });
  assert.equal(db.batches.length, 1);
  const sampleInsert = db.batches[0][3].sql;
  assert.match(sampleInsert, /COALESCE\(l\.quality_score,1\)/);
  assert.match(sampleInsert, /COALESCE\(l\.quality_flags,'\[\]'\)/);

  const stateWrite = db.calls.find((call) => (
    call.kind === 'run' && call.sql.includes('INSERT INTO sh_data_maintenance_state')
  ));
  assert.ok(stateWrite);
  assert.match(stateWrite.sql, /last_cleanup_at=MAX\(sh_data_maintenance_state\.last_cleanup_at,excluded\.last_cleanup_at\)/);
  assert.match(stateWrite.sql, /legacy_backfill_id=MAX\(sh_data_maintenance_state\.legacy_backfill_id,excluded\.legacy_backfill_id\)/);
  assert.match(stateWrite.sql, /updated_at=MAX\(sh_data_maintenance_state\.updated_at,excluded\.updated_at\)/);
  assert.match(stateWrite.sql, /WHEN excluded\.last_rollup_key>sh_data_maintenance_state\.last_rollup_key/);
  assert.deepEqual(stateWrite.params, [
    'rollup-retention-v1',
    '2026-07-04',
    now,
    5_002,
    now,
  ]);
});
