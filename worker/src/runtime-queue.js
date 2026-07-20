import {
  isMinutePipelineBatch,
  minutePipelineEnv,
} from './runtime-env.js';
import { MONITOR_MAINTENANCE_MESSAGE } from './runtime-scheduled.js';

const EMPTY_OPTIONS = Object.freeze({});

let monitorMaintenanceModulePromise;
let minutePipelineModulePromise;
let otherMonitorModulePromise;

function loadMonitorMaintenanceModule() {
  monitorMaintenanceModulePromise ||= import('./monitor-maintenance-entry.js');
  return monitorMaintenanceModulePromise;
}

function loadMinutePipelineModule() {
  minutePipelineModulePromise ||= import('./minute-pipeline-entry.js');
  return minutePipelineModulePromise;
}

function loadOtherMonitorModule() {
  otherMonitorModulePromise ||= import('./other-monitor-entry.js');
  return otherMonitorModulePromise;
}

async function processMaintenanceMessage(message, env, options = EMPTY_OPTIONS) {
  const body = message?.body || {};
  try {
    const { runMonitorMaintenanceCron } = await loadMonitorMaintenanceModule();
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

export async function runRuntimeQueue(batch, env, ctx, options = EMPTY_OPTIONS) {
  const messages = batch?.messages;
  if (!messages?.length) return;

  if (isMinutePipelineBatch(batch)) {
    const minutePipeline = await loadMinutePipelineModule();
    return minutePipeline.processMinutePipelineBatch(
      batch,
      minutePipelineEnv(env),
      ctx,
      options.minutePipelineDependencies || EMPTY_OPTIONS,
    );
  }

  let otherMonitor = null;
  for (const message of messages) {
    if (message?.body?.message_type === MONITOR_MAINTENANCE_MESSAGE) {
      await processMaintenanceMessage(message, env, options);
      continue;
    }
    otherMonitor ||= await loadOtherMonitorModule();
    await otherMonitor.runOtherMonitorQueue({ ...batch, messages: [message] }, env, ctx);
  }
}

export const runConsolidatedMonitorQueue = runRuntimeQueue;
