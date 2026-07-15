import assert from 'node:assert/strict';
import test from 'node:test';

import {
  legacyMigrationEnabled,
  resetDataMaintenanceRuntimeState,
  runDataMaintenance,
  runDataMaintenanceSafely,
} from '../functions/lib/data-maintenance.js';

test('legacy Pages maintenance is retired and does not touch a database', async () => {
  const trap = new Proxy({}, { get() { throw new Error('retired maintenance must not touch D1'); } });
  assert.equal(legacyMigrationEnabled(), false);
  resetDataMaintenanceRuntimeState(trap);
  assert.deepEqual(await runDataMaintenance(trap), {
    skipped: true,
    reason: 'legacy-maintenance-retired',
    legacyBackfill: { skipped: true, reason: 'legacy-migration-disabled' },
  });
  assert.deepEqual(await runDataMaintenanceSafely(trap), {
    skipped: true,
    reason: 'legacy-maintenance-retired',
    legacyBackfill: { skipped: true, reason: 'legacy-migration-disabled' },
  });
});
