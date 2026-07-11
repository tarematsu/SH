export const LEGACY_MIGRATION_DISABLED_REASON = 'legacy-migration-disabled';

export function legacyMigrationEnabled() {
  return false;
}

export async function runMinuteFactsBackfill() {
  return {
    skipped: true,
    reason: LEGACY_MIGRATION_DISABLED_REASON,
    migrated: 0,
  };
}
