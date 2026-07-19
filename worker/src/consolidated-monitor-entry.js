import './fetch-guard.js';
import otherMonitor, {
  OTHER_MONITOR_CRON,
  runOtherMonitorCron,
} from './other-monitor-entry.js';
import {
  ROLLUP_MAINTENANCE_CRON,
  SNAPSHOT_RETENTION_CRON,
  runMonitorMaintenanceCron,
} from './monitor-maintenance-entry.js';

const EMPTY_OPTIONS = Object.freeze({});
const MAINTENANCE_CRONS = new Set([
  ROLLUP_MAINTENANCE_CRON,
  SNAPSHOT_RETENTION_CRON,
]);

export {
  OTHER_MONITOR_CRON,
  ROLLUP_MAINTENANCE_CRON,
  SNAPSHOT_RETENTION_CRON,
};

export async function runConsolidatedMonitorScheduled(
  controller,
  env,
  ctx,
  options = EMPTY_OPTIONS,
) {
  const cron = String(controller?.cron || '');
  if (cron === OTHER_MONITOR_CRON) {
    return runOtherMonitorCron(controller, env, ctx, options.otherOptions || EMPTY_OPTIONS);
  }
  if (MAINTENANCE_CRONS.has(cron)) {
    return runMonitorMaintenanceCron(
      controller,
      env,
      options.maintenanceDependencies || EMPTY_OPTIONS,
    );
  }
  return { skipped: true, reason: 'unsupported-consolidated-monitor-cron', cron };
}

export default {
  ...otherMonitor,
  scheduled: runConsolidatedMonitorScheduled,
};
