const DEFAULT_INTERVAL_MS = 60 * 60_000;
const MIN_INTERVAL_MS = 15 * 60_000;
export const LEGACY_MIGRATION_DISABLED_REASON = 'legacy-migration-disabled';

function intervalMs(env = {}) {
  const configured = Number(env.DATA_MAINTENANCE_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.trunc(configured));
}

export function dataMaintenanceEnabled(env = {}) {
  const configured = env.DATA_MAINTENANCE_ENABLED;
  if (configured == null || configured === '') return true;
  const normalized = String(configured).trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(normalized);
}

export function shouldRunScheduledMaintenance(now = Date.now(), env = {}) {
  const interval = intervalMs(env);
  const minute = Math.floor(now / 60_000);
  const intervalMinutes = Math.max(1, Math.round(interval / 60_000));
  return minute % intervalMinutes === 0;
}

export function minuteFactsCutoverEnabled(env = {}) {
  return Boolean(env?.MINUTE_DB);
}

export function legacyMigrationEnabled() {
  return false;
}

export async function runScheduledMaintenance(env, now = Date.now()) {
  const sourceDb = env?.BUDDIES_DB;
  if (!sourceDb || !env?.MINUTE_DB || !env?.OTHER_DB) {
    return { skipped: true, reason: 'db-binding-missing' };
  }
  if (!dataMaintenanceEnabled(env)) {
    return { skipped: true, reason: 'disabled' };
  }
  if (!shouldRunScheduledMaintenance(now, env)) {
    return { skipped: true, reason: 'not-due' };
  }

  const rollup = await runRollupMaintenanceSafely(sourceDb, env.OTHER_DB, now);
  return {
    skipped: false,
    reason: 'completed',
    rollup,
    legacyBackfill: { skipped: true, reason: LEGACY_MIGRATION_DISABLED_REASON },
    minuteFactsBackfill: { skipped: true, reason: LEGACY_MIGRATION_DISABLED_REASON },
  };
}
import { runRollupMaintenanceSafely } from './rollup-maintenance.js';
