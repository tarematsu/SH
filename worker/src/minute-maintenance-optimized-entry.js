import {
  minuteMaintenanceTask,
  runMinuteScheduledWithCollectorPriority,
} from './minute-entry.js';

const MINUTE_DERIVE_DISPATCH_CRON = '* * * * *';
const EMPTY_DEPENDENCIES = Object.freeze({});
let maintenanceEntryPromise = null;
let rebuildMaintenanceEntryPromise = null;

function loadMaintenanceEntry() {
  if (!maintenanceEntryPromise) {
    maintenanceEntryPromise = import('./minute-maintenance-entry.js');
  }
  return maintenanceEntryPromise;
}

function loadRebuildMaintenanceEntry() {
  if (!rebuildMaintenanceEntryPromise) {
    rebuildMaintenanceEntryPromise = import('./minute-rebuild-maintenance-entry.js');
  }
  return rebuildMaintenanceEntryPromise;
}

function scheduledTimestamp(controller) {
  const value = controller?.scheduledTime;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : Date.now();
  }
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now();
}

function isDeriveDispatchCron(controller) {
  const value = controller?.cron;
  return value === MINUTE_DERIVE_DISPATCH_CRON
    || String(value || '') === MINUTE_DERIVE_DISPATCH_CRON;
}

export async function dispatchMinuteMaintenanceGate(controller, env, task, ctx = null) {
  if (!env?.MINUTE_REBUILD_QUEUE?.send) {
    return runMinuteScheduledWithCollectorPriority(controller, env, ctx, EMPTY_DEPENDENCIES);
  }
  const scheduledAt = scheduledTimestamp(controller);
  const cron = typeof controller?.cron === 'string' ? controller.cron : String(controller?.cron || '');
  const runId = `minute-maintenance:${task}:${scheduledAt}`;
  const message = {
    message_type: 'minute-rebuild-stage',
    message_version: 1,
    run_id: runId,
    stage: 'maintenance-gate',
    maintenance_task: task,
    scheduled_at: scheduledAt,
    cron,
    attempt: 0,
  };
  const maintenance = await loadRebuildMaintenanceEntry();
  const result = await maintenance.processMinuteMaintenanceGate(env, message);
  console.log(JSON.stringify({
    event: 'minute_maintenance_gate_inlined',
    task,
    run_id: runId,
    pending: result?.pending === true,
    skipped: result?.skipped === true,
    reason: result?.reason,
    requeued: result?.requeued === true,
    dispatched_stage: result?.dispatched_stage,
    historical_backfill_due: result?.historical_backfill_due,
  }));
  return result;
}

export async function runMinuteMaintenanceScheduled(controller, env, ctx) {
  if (isDeriveDispatchCron(controller)) {
    const entry = await loadMaintenanceEntry();
    return entry.dispatchPendingMinuteFacts(env, EMPTY_DEPENDENCIES, ctx);
  }
  const task = minuteMaintenanceTask(controller);
  if (task === 'rebuild' || task === 'sync') {
    return dispatchMinuteMaintenanceGate(controller, env, task, ctx);
  }
  return runMinuteScheduledWithCollectorPriority(controller, env, ctx, EMPTY_DEPENDENCIES);
}

export default {
  scheduled: runMinuteMaintenanceScheduled,
};
