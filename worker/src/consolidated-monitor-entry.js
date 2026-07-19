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
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
export const MONITOR_MAINTENANCE_MESSAGE = 'monitor-maintenance-task';

export {
  OTHER_MONITOR_CRON,
  ROLLUP_MAINTENANCE_CRON,
  SNAPSHOT_RETENTION_CRON,
};

export function maintenanceCronFor(timestamp) {
  const minute = new Date(Number(timestamp) || 0).getUTCMinutes();
  if (minute === 30) return ROLLUP_MAINTENANCE_CRON;
  if (minute === 50) return SNAPSHOT_RETENTION_CRON;
  return null;
}

async function dispatchMaintenance(env, scheduledAt) {
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

export async function runConsolidatedMonitorScheduled(
  controller,
  env,
  ctx,
  options = EMPTY_OPTIONS,
) {
  const cron = String(controller?.cron || '');
  if (cron !== OTHER_MONITOR_CRON) {
    return { skipped: true, reason: 'unsupported-consolidated-monitor-cron', cron };
  }
  const result = await runOtherMonitorCron(
    controller,
    env,
    ctx,
    options.otherOptions || EMPTY_OPTIONS,
  );
  const scheduledAt = Number(controller?.scheduledTime) || Date.now();
  const maintenance = await dispatchMaintenance(env, scheduledAt);
  return maintenance ? [...result, maintenance] : result;
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
  const message = batch?.messages?.[0];
  if (message?.body?.message_type === MONITOR_MAINTENANCE_MESSAGE) {
    return processMaintenanceMessage(message, env, options);
  }
  return otherMonitor.queue(batch, env, ctx);
}

export default {
  ...otherMonitor,
  scheduled: runConsolidatedMonitorScheduled,
  queue: runConsolidatedMonitorQueue,
};
