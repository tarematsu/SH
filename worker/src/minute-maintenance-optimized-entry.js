import {
  minuteMaintenanceTask,
  runMinuteScheduledWithCollectorPriority,
} from './minute-entry.js';
import {
  dispatchPendingMinuteFacts,
  MINUTE_DERIVE_DISPATCH_CRON,
} from './minute-maintenance-entry.js';

const EMPTY_DEPENDENCIES = Object.freeze({});
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
const DEFAULT_STAGGER_MS = 12_000;
const MAX_STAGGER_MS = 45_000;

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

function staggerEnabled(env) {
  const value = env?.CRON_STAGGER_ENABLED;
  if (value == null || value === '') return true;
  const normalized = String(value).trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'no' && normalized !== 'off';
}

function maintenanceDelaySeconds(env) {
  if (!staggerEnabled(env)) return 0;
  const configured = Number(env?.CRON_STAGGER_MINUTE_MS);
  const delayMs = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_STAGGER_MS;
  return Math.ceil(Math.min(MAX_STAGGER_MS, delayMs) / 1000);
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
  const delaySeconds = maintenanceDelaySeconds(env);
  const options = delaySeconds > 0
    ? { contentType: 'json', delaySeconds }
    : JSON_QUEUE_SEND_OPTIONS;
  await env.MINUTE_REBUILD_QUEUE.send(message, options);
  const result = {
    event: 'minute_maintenance_gate_dispatched',
    task,
    run_id: runId,
    delay_seconds: delaySeconds,
  };
  console.log(JSON.stringify(result));
  return result;
}

export function runMinuteMaintenanceScheduled(controller, env, ctx) {
  if (isDeriveDispatchCron(controller)) {
    return dispatchPendingMinuteFacts(env, EMPTY_DEPENDENCIES, ctx);
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
