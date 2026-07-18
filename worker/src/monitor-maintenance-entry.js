import './fetch-guard.js';

export const ROLLUP_MAINTENANCE_CRON = '30 * * * *';
export const SNAPSHOT_RETENTION_CRON = '50 * * * *';

const EMPTY_DEPENDENCIES = Object.freeze({});
let cronStaggerModulePromise;
let rollupModulePromise;
let retentionModulePromise;

function loadCronStaggerModule() {
  cronStaggerModulePromise ||= import('./cron-stagger.js');
  return cronStaggerModulePromise;
}

function loadRollupModule() {
  rollupModulePromise ||= import('./rollup-maintenance.js');
  return rollupModulePromise;
}

function loadRetentionModule() {
  retentionModulePromise ||= import('./snapshot-retention.js');
  return retentionModulePromise;
}

function scheduledTimestamp(controller) {
  const value = controller?.scheduledTime;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : Date.now();
  }
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now();
}

function monitorCron(controller) {
  const value = controller?.cron;
  if (value === ROLLUP_MAINTENANCE_CRON || value === SNAPSHOT_RETENTION_CRON) return value;
  return String(value || '');
}

async function collectorGate(env, now, dependencies = EMPTY_DEPENDENCIES) {
  if (!env?.BUDDIES_DB?.prepare && !dependencies.waitForCollector) return null;
  const waitForCollector = dependencies.waitForCollector
    || (await loadCronStaggerModule()).waitForCollectorCompletion;
  return waitForCollector(env, now);
}

function assertMaintenanceSucceeded(kind, result) {
  const reason = result?.reason;
  if (reason === 'maintenance-error' || reason === 'retention-error' || reason === 'db-binding-missing') {
    throw new Error(`${kind} failed: ${result?.error || reason}`);
  }
  return result;
}

export async function runMonitorMaintenanceCron(controller, env, dependencies = EMPTY_DEPENDENCIES) {
  const cron = monitorCron(controller);
  if (cron !== ROLLUP_MAINTENANCE_CRON && cron !== SNAPSHOT_RETENTION_CRON) {
    return { skipped: true, reason: 'unsupported-monitor-maintenance-cron', cron };
  }

  const now = scheduledTimestamp(controller);
  const applyStagger = dependencies.applyStagger
    || (await loadCronStaggerModule()).applyCronStagger;
  await applyStagger(env, 'other');

  const collector = await collectorGate(env, now, dependencies);
  if (collector && !collector.ready) {
    return { skipped: true, reason: collector.reason, targetMinute: collector.targetMinute };
  }

  if (cron === ROLLUP_MAINTENANCE_CRON) {
    if (!env?.BUDDIES_DB || !env?.OTHER_DB) {
      return assertMaintenanceSucceeded('rollup maintenance', { skipped: true, reason: 'db-binding-missing' });
    }
    const runRollup = dependencies.runRollup
      || (await loadRollupModule()).runRollupMaintenanceSafely;
    return assertMaintenanceSucceeded('rollup maintenance', await runRollup(env.BUDDIES_DB, env.OTHER_DB, now));
  }

  const pruneSnapshots = dependencies.pruneSnapshots
    || (await loadRetentionModule()).pruneOldSnapshotsSafely;
  return assertMaintenanceSucceeded('snapshot retention', await pruneSnapshots(env, now));
}

export default {
  scheduled: runMonitorMaintenanceCron,
};
