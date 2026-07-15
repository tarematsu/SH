// Retired legacy maintenance entry point.
//
// Live rollup/retention ownership now belongs to the Worker that has the
// explicit BUDDIES_DB and OTHER_DB bindings. Keeping this compatibility
// module avoids breaking old imports while preventing the former Pages path
// from writing summary tables into the wrong database.

export function legacyMigrationEnabled() {
  return false;
}

export function resetDataMaintenanceRuntimeState() {}

export async function runDataMaintenance() {
  return {
    skipped: true,
    reason: 'legacy-maintenance-retired',
    legacyBackfill: { skipped: true, reason: 'legacy-migration-disabled' },
  };
}

export async function runDataMaintenanceSafely() {
  return runDataMaintenance();
}
