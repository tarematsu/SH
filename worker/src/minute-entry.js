import { runMinuteFactDeriveCron } from './minute-facts-derive.js';
import { requeueDeadMinuteFactJobs } from './minute-facts-inbox.js';
import { consumeMinuteFactBatch } from './minute-facts-queue.js';
import {
  hasMinuteFactQueueReceipt,
  saveMinuteFactQueueReceipt,
  saveMinuteFactReadModels,
} from './minute-facts-read-model.js';
import { minuteFactRuntimeSignals, readMinuteFactRuntimeState, recordMinuteFactRuntimeState } from './minute-facts-runtime-state.js';
import { createPublicHealthCachedApp } from './public-health-cache.js';

export const MINUTE_FACT_DERIVE_CRON = '*/2 * * * *';
export const MINUTE_FACT_WORKER_CRON = '* * * * *';
export const MINUTE_FACT_RECOVERY_MINUTE = 5;
const ACTIVE_HEALTH_TASKS = new Set(['derive', 'recovery']);

export function activeMinuteHealthTasks(tasks = []) {
  return tasks.filter((task) => ACTIVE_HEALTH_TASKS.has(String(task?.task_name || '')));
}

function scheduledMinute(controller = {}) {
  const timestamp = Number(controller.scheduledTime);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).getUTCMinutes();
}

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

async function runTracked(env, task, action) {
  const startedAt = Date.now();
  try {
    const result = await action();
    if (env?.FACTS_DB) await recordMinuteFactRuntimeState(env, task, result, { startedAt });
    return result;
  } catch (error) {
    if (env?.FACTS_DB) await recordMinuteFactRuntimeState(env, task, { error }, { startedAt, success: false }).catch(() => {});
    throw error;
  }
}

export async function runMinuteScheduled(controller = {}, env, dependencies = {}) {
  const cron = String(controller.cron || '');
  if (cron === MINUTE_FACT_DERIVE_CRON) return (dependencies.runDerive || runMinuteFactDeriveCron)(env, dependencies.derive || {});
  if (cron === MINUTE_FACT_WORKER_CRON) {
    const minute = scheduledMinute(controller);
    if (minute == null) return { skipped: true, reason: 'scheduled-time-missing' };
    if (minute % 10 === MINUTE_FACT_RECOVERY_MINUTE) {
      if (!enabled(env.MINUTE_FACT_AUTO_REQUEUE_DEAD)) return { skipped: true, reason: 'dead-job-auto-requeue-disabled' };
      return runTracked(env, 'recovery', () => (dependencies.requeueDead || requeueDeadMinuteFactJobs)(env, { limit: env.MINUTE_FACT_DEAD_REQUEUE_LIMIT }));
    }
    if (minute % 2 === 0) return runTracked(env, 'derive', () => (dependencies.runDerive || runMinuteFactDeriveCron)(env, dependencies.derive || {}));
    return { skipped: true, reason: 'not-due', minute };
  }
  return { skipped: true, reason: 'unsupported-minute-facts-cron', cron };
}

const rawApp = {
  async queue(batch, env) {
    return consumeMinuteFactBatch(batch, env, {
      hasReceipt: hasMinuteFactQueueReceipt,
      saveReceipt: saveMinuteFactQueueReceipt,
      saveReadModels: saveMinuteFactReadModels,
    });
  },
  async scheduled(controller, env, ctx) {
    return runMinuteScheduled(controller, env, { ctx });
  },
  async fetch(request, env) {
    if (request.method !== 'GET' || new URL(request.url).pathname !== '/health') return new Response('Not found', { status: 404 });
    const tasks = activeMinuteHealthTasks(await readMinuteFactRuntimeState(env));
    const health = tasks.map((task) => ({
      task_name: task.task_name,
      ...minuteFactRuntimeSignals(task, { pendingAgeMs: env.MINUTE_FACT_PENDING_ALERT_MS }),
    }));
    const ok = health.every((task) => !task.has_dead_jobs && !task.pending_stale && !task.last_run_failed);
    return Response.json({ ok, tasks: health });
  },
};

const cachedApp = createPublicHealthCachedApp(rawApp);

export default {
  ...cachedApp,
  queue: rawApp.queue,
};
