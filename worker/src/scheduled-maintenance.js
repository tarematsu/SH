import { runDataMaintenanceSafely } from '../../site/functions/lib/data-maintenance.js';
import { runMinuteFactsBackfill } from './minute-facts-backfill.js';
import { runRollupMaintenanceSafely } from './rollup-maintenance.js';

const DEFAULT_INTERVAL_MS = 60 * 60_000;
const MIN_INTERVAL_MS = 15 * 60_000;

function intervalMs(env = {}) {
  const configured = Number(env.DATA_MAINTENANCE_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.trunc(configured));
}

export function shouldRunScheduledMaintenance(now = Date.now(), env = {}) {
  const interval = intervalMs(env);
  const minute = Math.floor(now / 60_000);
  const intervalMinutes = Math.max(1, Math.round(interval / 60_000));
  return minute % intervalMinutes === 0;
}

export function minuteFactsCutoverEnabled(env = {}) {
  return Boolean(env?.DB && env?.FACTS_DB);
}

export async function runScheduledMaintenance(env, now = Date.now()) {
  if (!env?.DB) return { skipped: true, reason: 'db-binding-missing' };
  if (!shouldRunScheduledMaintenance(now, env)) {
    return { skipped: true, reason: 'not-due' };
  }
  if (!minuteFactsCutoverEnabled(env)) {
    return runDataMaintenanceSafely(env.DB, now);
  }

  const [rollup, minuteFactsBackfill] = await Promise.all([
    runRollupMaintenanceSafely(env.DB, now),
    runMinuteFactsBackfill(env).catch((error) => ({
      skipped: true,
      reason: 'minute-facts-backfill-error',
      error: error?.message || String(error),
    })),
  ]);
  return {
    skipped: false,
    rollup,
    legacyBackfill: { skipped: true, reason: 'replaced-by-minute-facts-migration' },
    minuteFactsBackfill,
  };
}
