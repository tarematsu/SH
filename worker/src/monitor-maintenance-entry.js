import './fetch-guard.js';

export const ROLLUP_MAINTENANCE_CRON = '30 * * * *';
export const SNAPSHOT_RETENTION_CRON = '50 * * * *';

async function collectorGate(env, now, dependencies = {}) {
  if (!env?.BUDDIES_DB?.prepare && !dependencies.waitForCollector) return null;
  const waitForCollector = dependencies.waitForCollector
    || (await import('./cron-stagger.js')).waitForCollectorCompletion;
  return waitForCollector(env, now);
}

export async function runMonitorMaintenanceCron(controller, env, dependencies = {}) {
  const cron = String(controller?.cron || '');
  if (cron !== ROLLUP_MAINTENANCE_CRON && cron !== SNAPSHOT_RETENTION_CRON) {
    return { skipped: true, reason: 'unsupported-monitor-maintenance-cron', cron };
  }

  const now = Number(controller?.scheduledTime) || Date.now();
  const applyStagger = dependencies.applyStagger
    || (await import('./cron-stagger.js')).applyCronStagger;
  await applyStagger(env, 'other');

  const collector = await collectorGate(env, now, dependencies);
  if (collector && !collector.ready) {
    return { skipped: true, reason: collector.reason, targetMinute: collector.targetMinute };
  }

  if (cron === ROLLUP_MAINTENANCE_CRON) {
    if (!env?.BUDDIES_DB || !env?.OTHER_DB) return { skipped: true, reason: 'db-binding-missing' };
    const runRollup = dependencies.runRollup
      || (await import('./rollup-maintenance.js')).runRollupMaintenanceSafely;
    return runRollup(env.BUDDIES_DB, env.OTHER_DB, now);
  }

  const pruneSnapshots = dependencies.pruneSnapshots
    || (await import('./snapshot-retention.js')).pruneOldSnapshotsSafely;
  return pruneSnapshots(env, now);
}

export default {
  scheduled: runMonitorMaintenanceCron,
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
