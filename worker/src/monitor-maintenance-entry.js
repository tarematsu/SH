import './fetch-guard.js';

export const ROLLUP_MAINTENANCE_CRON = '30 * * * *';
export const SNAPSHOT_RETENTION_CRON = '50 * * * *';

export async function runMonitorMaintenanceCron(controller, env) {
  const cron = String(controller?.cron || '');
  const now = Number(controller?.scheduledTime) || Date.now();
  if (cron === ROLLUP_MAINTENANCE_CRON) {
    if (!env?.BUDDIES_DB || !env?.OTHER_DB) return { skipped: true, reason: 'db-binding-missing' };
    const { runRollupMaintenanceSafely } = await import('./rollup-maintenance.js');
    return runRollupMaintenanceSafely(env.BUDDIES_DB, env.OTHER_DB, now);
  }
  if (cron === SNAPSHOT_RETENTION_CRON) {
    const { pruneOldSnapshotsSafely } = await import('./snapshot-retention.js');
    return pruneOldSnapshotsSafely(env, now);
  }
  return { skipped: true, reason: 'unsupported-monitor-maintenance-cron', cron };
}

export default {
  scheduled: runMonitorMaintenanceCron,
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
