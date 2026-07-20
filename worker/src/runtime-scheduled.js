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
export const RAW_COLLECTION_TASK_MESSAGE = 'raw-collection-task';

const MINUTE_FACT_MAINTENANCE_CRON = '5,7,9,15,17,19,25,27,29,35,37,39,45,47,49,55,57,59 * * * *';

let minuteMaintenanceModulePromise;
let minuteGateModulePromise;
let otherMonitorModulePromise;

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

async function dispatchRuntimeMessage(env, body, missingMessage) {
  if (!env?.HOST_MONITOR_QUEUE?.send) throw new Error(missingMessage);
  await env.HOST_MONITOR_QUEUE.send(body, JSON_QUEUE_SEND_OPTIONS);
}

export async function dispatchRawCollection(env, scheduledAt) {
  await dispatchRuntimeMessage(env, {
    message_type: RAW_COLLECTION_TASK_MESSAGE,
    message_version: 1,
    scheduled_at: scheduledAt,
  }, 'HOST_MONITOR_QUEUE binding is missing for raw collection dispatch');
  return { dispatched: true, task: 'raw-collection', scheduled_at: scheduledAt };
}

async function dispatchMonitorMaintenance(env, scheduledAt) {
  const cron = maintenanceCronFor(scheduledAt);
  if (!cron) return null;
  await dispatchRuntimeMessage(env, {
    message_type: MONITOR_MAINTENANCE_MESSAGE,
    message_version: 1,
    cron,
    scheduled_at: scheduledAt,
  }, 'HOST_MONITOR_QUEUE binding is missing for maintenance dispatch');
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
  const collection = dispatchRawCollection(env, scheduledAt);
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
  const [collectionResult, minuteResults, otherResults] = await Promise.all([
    collection,
    minuteTasks,
    otherTasks,
  ]);
  const maintenance = await dispatchMonitorMaintenance(env, scheduledAt);
  return [
    collectionResult,
    ...minuteResults,
    ...otherResults,
    ...(maintenance ? [maintenance] : []),
  ];
}

export const runConsolidatedMonitorScheduled = runRuntimeScheduled;
