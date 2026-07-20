import {
  isMinutePipelineBatch,
  minutePipelineEnv,
  rawCollectorEnv,
} from './runtime-env.js';
import { RAW_COLLECTION_FETCH_MESSAGE } from './raw-collection-messages.js';
import { textTransportQueue } from './raw-collection-text-transport.js';
import {
  MONITOR_MAINTENANCE_MESSAGE,
  OTHER_MONITOR_CRON,
  RAW_COLLECTION_TASK_MESSAGE,
  RUNTIME_MINUTE_GATE_MESSAGE,
  RUNTIME_MINUTE_RECOVERY_MESSAGE,
  RUNTIME_OTHER_MONITOR_MESSAGE,
  dispatchMinuteMaintenanceGate,
  dispatchMinuteRecovery,
} from './runtime-scheduled.js';

const EMPTY_OPTIONS = Object.freeze({});
const RETRY_30_SECONDS = Object.freeze({ delaySeconds: 30 });

let monitorMaintenanceModulePromise;
let minutePipelineModulePromise;
let otherMonitorModulePromise;
let otherMonitorDispatchModulePromise;
let rawCollectionFetchModulePromise;
let rawCollectionSessionModulePromise;

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

function loadOtherMonitorDispatchModule() {
  otherMonitorDispatchModulePromise ||= import('./runtime-other-monitor-dispatch.js');
  return otherMonitorDispatchModulePromise;
}

function loadRawCollectionSessionModule() {
  rawCollectionSessionModulePromise ||= import('./raw-collection-session-entry.js');
  return rawCollectionSessionModulePromise;
}

function loadRawCollectionFetchModule() {
  rawCollectionFetchModulePromise ||= import('./raw-collection-fetch-entry.js');
  return rawCollectionFetchModulePromise;
}

function rawCollectorTextEnv(env) {
  const active = rawCollectorEnv(env);
  const queue = active?.RAW_COLLECTION_QUEUE;
  if (!queue?.send) return active;
  const scoped = Object.create(active);
  Object.defineProperty(scoped, 'RAW_COLLECTION_QUEUE', {
    value: textTransportQueue(queue),
    enumerable: false,
    configurable: true,
  });
  return scoped;
}

async function processRawCollectionMessage(message, env, options = EMPTY_OPTIONS) {
  const body = message?.body || {};
  try {
    if (Number(body.message_version) !== 1) throw new Error('unsupported raw collection task version');
    if (options.collectRawChannel) {
      await options.collectRawChannel(
        rawCollectorTextEnv(env),
        options.collectionDependencies || EMPTY_OPTIONS,
      );
    } else {
      const session = await loadRawCollectionSessionModule();
      await session.prepareRawCollectionFetch(
        rawCollectorEnv(env),
        body,
        options.collectionDependencies || EMPTY_OPTIONS,
      );
    }
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({
      event: 'raw_collection_queue_failed',
      scheduled_at: Number(body.scheduled_at) || null,
      error: String(error?.message || error).slice(0, 800),
    }));
    message.retry(RETRY_30_SECONDS);
  }
}

async function processRawCollectionFetchMessage(message, env, options = EMPTY_OPTIONS) {
  const body = message?.body || {};
  try {
    const fetchStage = await loadRawCollectionFetchModule();
    await fetchStage.fetchPreparedRawCollection(
      rawCollectorTextEnv(env),
      body,
      options.collectionFetchDependencies || EMPTY_OPTIONS,
    );
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({
      event: 'raw_collection_fetch_queue_failed',
      scheduled_at: Number(body.scheduled_at) || null,
      error: String(error?.message || error).slice(0, 800),
    }));
    message.retry(RETRY_30_SECONDS);
  }
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

async function processRuntimeDispatchMessage(message, env, ctx, options = EMPTY_OPTIONS) {
  const body = message?.body || {};
  const messageType = body.message_type;
  const scheduledTime = Number(body.scheduled_at) || Date.now();
  try {
    if (Number(body.message_version) !== 1) throw new Error('unsupported runtime dispatch version');
    const controller = { cron: OTHER_MONITOR_CRON, scheduledTime };
    if (messageType === RUNTIME_MINUTE_RECOVERY_MESSAGE) {
      await dispatchMinuteRecovery(controller, env, ctx, options);
    } else if (messageType === RUNTIME_MINUTE_GATE_MESSAGE) {
      await dispatchMinuteMaintenanceGate(controller, env, String(body.task || ''), ctx, options);
    } else if (messageType === RUNTIME_OTHER_MONITOR_MESSAGE) {
      const run = options.runOtherMonitorCron
        || (await loadOtherMonitorDispatchModule()).dispatchOtherMonitorStage;
      await run(controller, env, ctx, {
        ...(options.otherOptions || EMPTY_OPTIONS),
        deferSuccess: true,
      });
    } else {
      throw new Error(`unsupported runtime dispatch type: ${String(messageType || 'unknown')}`);
    }
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({
      event: 'runtime_dispatch_queue_failed',
      message_type: String(messageType || 'unknown'),
      task: body.task ?? null,
      scheduled_at: scheduledTime,
      error: String(error?.message || error).slice(0, 800),
    }));
    message.retry(RETRY_30_SECONDS);
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
    const messageType = message?.body?.message_type;
    if (messageType === RAW_COLLECTION_TASK_MESSAGE) {
      await processRawCollectionMessage(message, env, options);
      continue;
    }
    if (messageType === RAW_COLLECTION_FETCH_MESSAGE) {
      await processRawCollectionFetchMessage(message, env, options);
      continue;
    }
    if (messageType === MONITOR_MAINTENANCE_MESSAGE) {
      await processMaintenanceMessage(message, env, options);
      continue;
    }
    if (messageType === RUNTIME_MINUTE_RECOVERY_MESSAGE
        || messageType === RUNTIME_MINUTE_GATE_MESSAGE
        || messageType === RUNTIME_OTHER_MONITOR_MESSAGE) {
      await processRuntimeDispatchMessage(message, env, ctx, options);
      continue;
    }
    otherMonitor ||= await loadOtherMonitorModule();
    await otherMonitor.runOtherMonitorQueue({ ...batch, messages: [message] }, env, ctx);
  }
}

export {
  processRawCollectionFetchMessage,
  processRawCollectionMessage,
  processRuntimeDispatchMessage,
  rawCollectorTextEnv,
};

export const runConsolidatedMonitorQueue = runRuntimeQueue;
