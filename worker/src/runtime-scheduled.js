import { rawCollectorEnv } from './runtime-env.js';

const EMPTY_OPTIONS = Object.freeze({});
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
const OTHER_MONITOR_INTERVAL_MINUTES = 5;
const MINUTE_RECOVERY_POLL_INTERVAL_MINUTES = 5;
const MINUTE_RECOVERY_POLL_OFFSET_MINUTE = 1;

export const RUNTIME_CRON = '* * * * *';
export const CONSOLIDATED_MONITOR_CRON = RUNTIME_CRON;
export const OTHER_MONITOR_CRON = '*/5 * * * *';
export const ROLLUP_MAINTENANCE_CRON = '30 * * * *';
export const SNAPSHOT_RETENTION_CRON = '50 * * * *';
export const MONITOR_MAINTENANCE_MESSAGE = 'monitor-maintenance-task';

const MINUTE_FACT_MAINTENANCE_CRON = '5,7,9,15,17,19,25,27,29,35,37,39,45,47,49,55,57,59 * * * *';

let rawCollectorModulePromise;
let minuteMaintenanceModulePromise;
let minuteGateModulePromise;
let otherMonitorModulePromise;

function loadRawCollectorModule() {
  rawCollectorModulePromise ||= import('./raw-collector-entry.js');
  return rawCollectorModulePromise;
}

function loadMinuteMaintenanceModule() {
  minuteMaintenanceModulePromise ||= import('./minute-maintenance-entry.js');
  return minuteMaintenanceModulePromise;
}

function loadMinuteGateModule() {
  minuteGateModulePromise ||= import('./minute-maintenance-optimized-entry.js');
  return minuteGateModulePromise;
}

function loadOtherMonitorModule() {
  otherMonitorModulePromise ||= import('./other-monitor-entry.js');
  return otherMonitorModulePromise;
}

export function maintenanceCronFor(timestamp) {
  const minute = new Date(Number(timestamp) || 0).getUTCMinutes();
  if (minute === 30) return ROLLUP_MAINTENANCE_CRON;
  if (minute === 50) return SNAPSHOT_RETENTION_CRON;
  return null;
}

export function minuteMaintenanceTaskFor(timestamp) {
  const minute = new Date(Number(timestamp) || 0).getUTCMinutes();
  const slot = ((minute % 10) + 10) % 10;
  if (slot === 5) return 'recovery';
  if (slot === 7) return 'rebuild';
  if (slot === 9) return 'sync';
  return null;
}

export function minuteRecoveryPollDue(timestamp) {
  const minute = new Date(Number(timestamp) || 0).getUTCMinutes();
  return minute % MINUTE_RECOVERY_POLL_INTERVAL_MINUTES === MINUTE_RECOVERY_POLL_OFFSET_MINUTE;
}

export function otherMonitorDue(timestamp) {
  const minute = new Date(Number(timestamp) || 0).getUTCMinutes();
  return minute % OTHER_MONITOR_INTERVAL_MINUTES === 0;
}

async function dispatchMonitorMaintenance(env, scheduledAt) {
  const cron = maintenanceCronFor(scheduledAt);
  if (!cron) return null;
  if (!env?.HOST_MONITOR_QUEUE?.send) {
    throw new Error('HOST_MONITOR_QUEUE binding is missing for maintenance dispatch');
  }
  await env.HOST_MONITOR_QUEUE.send({
    message_type: MONITOR_MAINTENANCE_MESSAGE,
    message_version: 1,
    cron,
    scheduled_at: scheduledAt,
  }, JSON_QUEUE_SEND_OPTIONS);
  return { dispatched: true, task: 'maintenance', cron, scheduled_at: scheduledAt };
}

export async function dispatchMinuteMaintenance(controller, env, ctx, options = EMPTY_OPTIONS) {
  const scheduledAt = Number(controller?.scheduledTime) || Date.now();
  const derive = minuteRecoveryPollDue(scheduledAt)
    ? (options.dispatchPendingMinuteFacts
      || (await loadMinuteMaintenanceModule()).dispatchPendingMinuteFacts)(
        env,
        options.minuteDispatchDependencies || EMPTY_OPTIONS,
        ctx,
      )
    : Promise.resolve(null);
  const task = minuteMaintenanceTaskFor(scheduledAt);
  const gate = task
    ? (options.dispatchMinuteMaintenanceGate
      || (await loadMinuteGateModule()).dispatchMinuteMaintenanceGate)({
        ...controller,
        cron: MINUTE_FACT_MAINTENANCE_CRON,
        scheduledTime: scheduledAt,
      }, env, task, ctx)
    : Promise.resolve(null);
  const [deriveResult, gateResult] = await Promise.all([derive, gate]);
  return [
    ...(deriveResult ? [deriveResult] : []),
    ...(gateResult ? [gateResult] : []),
  ];
}

export async function runRuntimeScheduled(controller, env, ctx, options = EMPTY_OPTIONS) {
  const cron = String(controller?.cron || '');
  if (cron !== RUNTIME_CRON && cron !== OTHER_MONITOR_CRON) {
    return { skipped: true, reason: 'unsupported-runtime-cron', cron };
  }
  const scheduledAt = Number(controller?.scheduledTime) || Date.now();
  const collect = options.collectRawChannel
    || (await loadRawCollectorModule()).collectRawChannel;
  const collection = collect(rawCollectorEnv(env), options.collectionDependencies || EMPTY_OPTIONS);
  const minuteTasks = dispatchMinuteMaintenance(controller, env, ctx, options);
  const monitorController = {
    ...controller,
    cron: OTHER_MONITOR_CRON,
    scheduledTime: scheduledAt,
  };
  const otherTasks = otherMonitorDue(scheduledAt)
    ? (await loadOtherMonitorModule()).runOtherMonitorCron(
        monitorController,
        env,
        ctx,
        options.otherOptions || EMPTY_OPTIONS,
      )
    : Promise.resolve([]);
  const [, minuteResults, otherResults] = await Promise.all([
    collection,
    minuteTasks,
    otherTasks,
  ]);
  const maintenance = await dispatchMonitorMaintenance(env, scheduledAt);
  return [
    { collected: true, scheduled_at: scheduledAt },
    ...minuteResults,
    ...otherResults,
    ...(maintenance ? [maintenance] : []),
  ];
}

export const runConsolidatedMonitorScheduled = runRuntimeScheduled;
