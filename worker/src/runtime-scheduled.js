const EMPTY_OPTIONS = Object.freeze({});
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
const MINUTE_MS = 60_000;
const MINUTE_RECOVERY_POLL_INTERVAL_MINUTES = 5;
const MINUTE_RECOVERY_POLL_OFFSET_MINUTE = 1;

export const RUNTIME_CRON = '* * * * *';
export const CONSOLIDATED_MONITOR_CRON = RUNTIME_CRON;
export const ROLLUP_MAINTENANCE_CRON = '30 * * * *';
export const SNAPSHOT_RETENTION_CRON = '50 * * * *';
export const MONITOR_MAINTENANCE_MESSAGE = 'monitor-maintenance-task';
export const RAW_COLLECTION_TASK_MESSAGE = 'raw-collection-task';
export const RUNTIME_MINUTE_RECOVERY_MESSAGE = 'runtime-minute-recovery-dispatch';
export const RUNTIME_MINUTE_GATE_MESSAGE = 'runtime-minute-maintenance-gate-dispatch';
export const RUNTIME_STREAM_PREDICTION_MESSAGE = 'runtime-stream-prediction-dispatch';

const MINUTE_FACT_MAINTENANCE_CRON = '5,7,9,15,17,19,25,27,29,35,37,39,45,47,49,55,57,59 * * * *';

let minuteMaintenanceModulePromise;
let minuteGateModulePromise;
let pipelineAnalyticsModulePromise;

function loadMinuteMaintenanceModule() {
  minuteMaintenanceModulePromise ||= import('./minute-maintenance-entry.js');
  return minuteMaintenanceModulePromise;
}

function loadMinuteGateModule() {
  minuteGateModulePromise ||= import('./minute-maintenance-optimized-entry.js');
  return minuteGateModulePromise;
}

function loadPipelineAnalyticsModule() {
  pipelineAnalyticsModulePromise ||= import('./runtime-pipeline-analytics.js');
  return pipelineAnalyticsModulePromise;
}

function utcMinute(timestamp) {
  const value = Number(timestamp) || 0;
  return ((Math.floor(value / MINUTE_MS) % 60) + 60) % 60;
}

export function maintenanceCronFor(timestamp) {
  const minute = utcMinute(timestamp);
  if (minute === 30) return ROLLUP_MAINTENANCE_CRON;
  if (minute === 50) return SNAPSHOT_RETENTION_CRON;
  return null;
}

export function minuteMaintenanceTaskFor(timestamp) {
  const slot = utcMinute(timestamp) % 10;
  if (slot === 5) return 'recovery';
  if (slot === 7) return 'rebuild';
  if (slot === 9) return 'sync';
  return null;
}

export function minuteRecoveryPollDue(timestamp) {
  return utcMinute(timestamp) % MINUTE_RECOVERY_POLL_INTERVAL_MINUTES
    === MINUTE_RECOVERY_POLL_OFFSET_MINUTE;
}

export function streamPredictionDue(timestamp) {
  const minute = utcMinute(timestamp);
  return minute === 10 || minute === 40;
}

export function runtimeScheduledMessagesFor(scheduledAt) {
  const messages = [{
    message_type: RAW_COLLECTION_TASK_MESSAGE,
    message_version: 1,
    scheduled_at: scheduledAt,
  }];
  if (minuteRecoveryPollDue(scheduledAt)) {
    messages.push({
      message_type: RUNTIME_MINUTE_RECOVERY_MESSAGE,
      message_version: 1,
      scheduled_at: scheduledAt,
    });
  }
  const minuteTask = minuteMaintenanceTaskFor(scheduledAt);
  if (minuteTask) {
    messages.push({
      message_type: RUNTIME_MINUTE_GATE_MESSAGE,
      message_version: 1,
      task: minuteTask,
      scheduled_at: scheduledAt,
    });
  }
  if (streamPredictionDue(scheduledAt)) {
    messages.push({
      message_type: RUNTIME_STREAM_PREDICTION_MESSAGE,
      message_version: 1,
      scheduled_at: scheduledAt,
    });
  }
  const maintenanceCron = maintenanceCronFor(scheduledAt);
  if (maintenanceCron) {
    messages.push({
      message_type: MONITOR_MAINTENANCE_MESSAGE,
      message_version: 1,
      cron: maintenanceCron,
      scheduled_at: scheduledAt,
    });
  }
  return messages;
}

async function sendRuntimeMessages(queue, messages) {
  if (queue?.sendBatch) {
    await queue.sendBatch(messages.map((body) => ({ body, contentType: 'json' })));
    return;
  }
  if (!queue?.send) throw new Error('HOST_MONITOR_QUEUE binding is missing for runtime dispatch');
  await Promise.all(messages.map((body) => queue.send(body, JSON_QUEUE_SEND_OPTIONS)));
}

async function scheduleRuntimeAnalytics(env, messages, scheduledAt, ctx, options) {
  if (!options.publishRuntimeAnalytics && typeof env?.RUNTIME_ANALYTICS_STREAM?.send !== 'function') {
    return;
  }
  const publish = options.publishRuntimeAnalytics
    || (await loadPipelineAnalyticsModule()).publishRuntimeScheduleAnalytics;
  const task = Promise.resolve(publish(
    env,
    messages,
    scheduledAt,
    options.pipelineAnalyticsDependencies || EMPTY_OPTIONS,
  )).catch((error) => {
    console.warn(JSON.stringify({
      event: 'runtime_pipeline_analytics_failed',
      error: String(error?.message || error).slice(0, 500),
    }));
  });
  if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(task);
  else await task;
}

export async function dispatchMinuteRecovery(controller, env, ctx, options = EMPTY_OPTIONS) {
  const scheduledAt = Number(controller?.scheduledTime) || Date.now();
  if (!minuteRecoveryPollDue(scheduledAt)) return null;
  const dispatch = options.dispatchPendingMinuteFacts
    || (await loadMinuteMaintenanceModule()).dispatchPendingMinuteFacts;
  return dispatch(env, options.minuteDispatchDependencies || EMPTY_OPTIONS, ctx);
}

export async function dispatchMinuteMaintenanceGate(
  controller,
  env,
  task,
  ctx,
  options = EMPTY_OPTIONS,
) {
  const scheduledAt = Number(controller?.scheduledTime) || Date.now();
  const activeTask = task || minuteMaintenanceTaskFor(scheduledAt);
  if (!activeTask) return null;
  const dispatch = options.dispatchMinuteMaintenanceGate
    || (await loadMinuteGateModule()).dispatchMinuteMaintenanceGate;
  return dispatch({
    ...controller,
    cron: MINUTE_FACT_MAINTENANCE_CRON,
    scheduledTime: scheduledAt,
  }, env, activeTask, ctx);
}

export async function dispatchMinuteMaintenance(controller, env, ctx, options = EMPTY_OPTIONS) {
  const scheduledAt = Number(controller?.scheduledTime) || Date.now();
  const [deriveResult, gateResult] = await Promise.all([
    dispatchMinuteRecovery({ ...controller, scheduledTime: scheduledAt }, env, ctx, options),
    dispatchMinuteMaintenanceGate(
      { ...controller, scheduledTime: scheduledAt },
      env,
      minuteMaintenanceTaskFor(scheduledAt),
      ctx,
      options,
    ),
  ]);
  return [
    ...(deriveResult ? [deriveResult] : []),
    ...(gateResult ? [gateResult] : []),
  ];
}

function runtimeDispatchResult(body) {
  const type = body.message_type;
  if (type === RAW_COLLECTION_TASK_MESSAGE) return { dispatched: true, task: 'raw-collection' };
  if (type === RUNTIME_MINUTE_RECOVERY_MESSAGE) return { dispatched: true, task: 'minute-recovery' };
  if (type === RUNTIME_MINUTE_GATE_MESSAGE) return { dispatched: true, task: `minute-${body.task}` };
  if (type === RUNTIME_STREAM_PREDICTION_MESSAGE) return { dispatched: true, task: 'stream-prediction' };
  return { dispatched: true, task: 'maintenance', cron: body.cron };
}

export async function runRuntimeScheduled(controller, env, ctx, options = EMPTY_OPTIONS) {
  const cron = String(controller?.cron || '');
  if (cron !== RUNTIME_CRON) {
    return { skipped: true, reason: 'unsupported-runtime-cron', cron };
  }
  const scheduledAt = Number(controller?.scheduledTime) || Date.now();
  const messages = runtimeScheduledMessagesFor(scheduledAt);
  await sendRuntimeMessages(env?.HOST_MONITOR_QUEUE, messages);
  await scheduleRuntimeAnalytics(env, messages, scheduledAt, ctx, options);
  return messages.map((body) => ({
    ...runtimeDispatchResult(body),
    scheduled_at: scheduledAt,
  }));
}

export const runConsolidatedMonitorScheduled = runRuntimeScheduled;
