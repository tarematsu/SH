import './fetch-guard.js';
import { runCloudHostMonitor } from './cloud-host-monitor.js';

function validateTask(body) {
  if (body?.message_type !== 'host-monitor-task' || Number(body?.message_version) !== 1) {
    throw new Error('unsupported host monitor task');
  }
  const scheduledAt = Number(body.scheduled_at);
  const observedAt = Number(body.observed_at);
  if (!Number.isFinite(scheduledAt) || !Number.isFinite(observedAt)) {
    throw new Error('host monitor task identity is invalid');
  }
  return { scheduledAt, observedAt };
}

export async function processHostMonitorTask(env, body, dependencies = {}) {
  const task = validateTask(body);
  const run = dependencies.run || runCloudHostMonitor;
  await run(env);
  return {
    event: 'host_monitor_task_completed',
    scheduled_at: task.scheduledAt,
    observed_at: task.observedAt,
    completed_at: Date.now(),
  };
}

export async function runHostMonitorQueue(batch, env, dependencies = {}) {
  for (const message of batch.messages || []) {
    try {
      const result = await processHostMonitorTask(env, message.body, dependencies);
      console.log(JSON.stringify(result));
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({
        event: 'host_monitor_task_failed',
        error: String(error?.message || error).slice(0, 800),
      }));
      message.retry();
    }
  }
}

export default {
  queue: runHostMonitorQueue,
};
