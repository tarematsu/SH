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
import { MINUTE_FACT_MAINTENANCE_CRON } from './minute-entry.js';
import { dispatchPendingMinuteFacts } from './minute-maintenance-entry.js';
import { dispatchMinuteMaintenanceGate } from './minute-maintenance-optimized-entry.js';
import { collectRawChannel } from './raw-collector-entry.js';

const EMPTY_OPTIONS = Object.freeze({});
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
const OTHER_MONITOR_INTERVAL_MINUTES = 5;
const MINUTE_RECOVERY_POLL_INTERVAL_MINUTES = 5;
const MINUTE_RECOVERY_POLL_OFFSET_MINUTE = 1;
export const CONSOLIDATED_MONITOR_CRON = '* * * * *';
export const MONITOR_MAINTENANCE_MESSAGE = 'monitor-maintenance-task';

export {
  OTHER_MONITOR_CRON,
  ROLLUP_MAINTENANCE_CRON,
  SNAPSHOT_RETENTION_CRON,
};

function rawCollectorEnv(env) {
  const active = Object.create(env || null);
  Object.defineProperty(active, 'DB', {
    value: env?.BUDDIES_DB,
    enumerable: false,
    configurable: true,
  });
  return active;
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

async function dispatchMinuteMaintenance(controller, env, ctx, options = EMPTY_OPTIONS) {
  const scheduledAt = Number(controller?.scheduledTime) || Date.now();
  const dispatchFacts = options.dispatchPendingMinuteFacts || dispatchPendingMinuteFacts;
  const dispatchGate = options.dispatchMinuteMaintenanceGate || dispatchMinuteMaintenanceGate;
  const derive = minuteRecoveryPollDue(scheduledAt)
    ? dispatchFacts(env, options.minuteDispatchDependencies || EMPTY_OPTIONS, ctx)
    : Promise.resolve(null);
  const task = minuteMaintenanceTaskFor(scheduledAt);
  const gate = task
    ? dispatchGate({
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

export async function runConsolidatedMonitorScheduled(
  controller,
  env,
  ctx,
  options = EMPTY_OPTIONS,
) {
  const cron = String(controller?.cron || '');
  if (cron !== CONSOLIDATED_MONITOR_CRON && cron !== OTHER_MONITOR_CRON) {
    return { skipped: true, reason: 'unsupported-consolidated-monitor-cron', cron };
  }
  const scheduledAt = Number(controller?.scheduledTime) || Date.now();
  const collect = options.collectRawChannel || collectRawChannel;
  const collection = collect(rawCollectorEnv(env), options.collectionDependencies || EMPTY_OPTIONS);
  const minuteTasks = dispatchMinuteMaintenance(controller, env, ctx, options);
  const monitorController = {
    ...controller,
    cron: OTHER_MONITOR_CRON,
    scheduledTime: scheduledAt,
  };
  const otherTasks = otherMonitorDue(scheduledAt)
    ? runOtherMonitorCron(monitorController, env, ctx, options.otherOptions || EMPTY_OPTIONS)
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

async function processMaintenanceMessage(message, env, options = EMPTY_OPTIONS) {
  const body = message?.body || {};
  try {
    await runMonitorMaintenanceCron({
      cron: String(body.cron || ''),
      scheduledTime: Number(body.scheduled_at) || Date.now(),
    }, env, options.maintenanceDependencies || EMPTY_OPTIONS);
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({
      event: 'monitor_maintenance_queue_failed',
      cron: String(body.cron || ''),
      error: String(error?.message || error).slice(0, 800),
    }));
    message.retry();
  }
}

export async function runConsolidatedMonitorQueue(batch, env, ctx, options = EMPTY_OPTIONS) {
  const messages = batch?.messages;
  if (!messages?.length) return;

  // Keep the consumer correct if batching is enabled later. The previous
  // first-message router could leave all remaining messages unacked or send a
  // mixed batch to the wrong handler.
  for (const message of messages) {
    if (message?.body?.message_type === MONITOR_MAINTENANCE_MESSAGE) {
      await processMaintenanceMessage(message, env, options);
      continue;
    }
    await otherMonitor.queue({ ...batch, messages: [message] }, env, ctx);
  }
}

export {
  dispatchMinuteMaintenance,
  rawCollectorEnv,
};

export default {
  ...otherMonitor,
  scheduled: runConsolidatedMonitorScheduled,
  queue: runConsolidatedMonitorQueue,
};
