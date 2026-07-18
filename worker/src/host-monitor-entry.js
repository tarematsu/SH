import './fetch-guard.js';
import { runCloudHostMonitor } from './cloud-host-monitor.js';
import { processHostMonitorStage } from './host-monitor-stages.js';

const RETRY_60_SECONDS = Object.freeze({ delaySeconds: 60 });
const EMPTY_DEPENDENCIES = Object.freeze({});
const HOST_STAGES = new Set(['plan', 'profile-fetch', 'profile-persist', 'solo-run']);

function validateTask(body) {
  if (body?.message_type !== 'host-monitor-task' || Number(body?.message_version) !== 1) {
    throw new Error('unsupported host monitor task');
  }
  const scheduledAt = Number(body.scheduled_at);
  const observedAt = Number(body.observed_at);
  if (!Number.isFinite(scheduledAt) || !Number.isFinite(observedAt)) {
    throw new Error('host monitor task identity is invalid');
  }
  const rawStage = typeof body.host_stage === 'string' ? body.host_stage : 'plan';
  const stage = HOST_STAGES.has(rawStage) ? rawStage : 'plan';
  return {
    scheduledAt,
    observedAt,
    stage,
    profile: body.profile && typeof body.profile === 'object' ? body.profile : null,
  };
}

export async function processHostMonitorTask(env, body, dependencies = EMPTY_DEPENDENCIES) {
  const task = validateTask(body);
  if (dependencies.run) {
    await dependencies.run(env);
    return {
      event: 'host_monitor_task_completed',
      stage: task.stage,
      scheduled_at: task.scheduledAt,
      observed_at: task.observedAt,
      completed_at: Date.now(),
    };
  }
  const process = dependencies.processStage || processHostMonitorStage;
  const result = await process(env, task, dependencies);
  return {
    event: 'host_monitor_task_completed',
    stage: result?.stage || task.stage,
    scheduled_at: task.scheduledAt,
    observed_at: task.observedAt,
    pending: result?.pending === true,
    profile_due: result?.profile_due,
    solo_due: result?.solo_due,
    dispatched: result?.dispatched,
    accepted: result?.accepted,
    duplicate: result?.duplicate,
  };
}

export async function runHostMonitorQueue(batch, env, dependencies = EMPTY_DEPENDENCIES) {
  const messages = batch?.messages;
  if (!messages?.length) return;
  const message = messages[0];
  try {
    const result = await processHostMonitorTask(env, message.body, dependencies);
    console.log(JSON.stringify(result));
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({
      event: 'host_monitor_task_failed',
      error: String(error?.message || error).slice(0, 800),
    }));
    message.retry(RETRY_60_SECONDS);
  }
}

export default {
  queue: runHostMonitorQueue,
};
