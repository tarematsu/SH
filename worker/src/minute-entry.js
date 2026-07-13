import { applyCronStagger } from './cron-stagger.js';
import { runMinuteFactsBackfill } from './minute-facts-backfill.js';
import { runMinuteFactDeriveCron } from './minute-facts-derive.js';
import { runMinuteFactsLegacyBackfill } from './minute-facts-legacy-backfill.js';
import { requeueDeadMinuteFactJobs } from './minute-facts-inbox.js';
import { minuteFactRuntimeSignals, readMinuteFactRuntimeState, recordMinuteFactRuntimeState } from './minute-facts-runtime-state.js';
import { createPublicHealthCachedApp } from './public-health-cache.js';

export const MINUTE_FACT_DERIVE_CRON = '*/2 * * * *';
export const MINUTE_FACT_REBUILD_CRON = '7,17,27,37,47,57 * * * *';
export const MINUTE_FACT_LEGACY_CRON = '9,19,29,39,49,59 * * * *';
export const MINUTE_FACT_WORKER_CRON = '* * * * *';
export const MINUTE_FACT_RECOVERY_MINUTE = 5;

function scheduledMinute(controller = {}) {
  const timestamp = Number(controller.scheduledTime);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).getUTCMinutes();
}

// The stagger is a blocking sleep, so only pay it before jobs that actually
// read the shared DB and could collide with buddies' top-of-minute writes.
// Derive and recovery touch only FACTS_DB; sleeping ahead of them just burns
// wall time (and, at the old 20s delay, tripped the minute worker's runtime
// limit every minute). Rebuild (minute ending in 7) and legacy (ending in 9)
// are the only DB-reading paths.
export function minuteStaggerApplies(controller = {}) {
  const cron = String(controller.cron || '');
  if (cron === MINUTE_FACT_REBUILD_CRON || cron === MINUTE_FACT_LEGACY_CRON) return true;
  if (cron !== MINUTE_FACT_WORKER_CRON) return false;
  const minute = scheduledMinute(controller);
  if (minute == null) return false;
  if (minute % 10 === MINUTE_FACT_RECOVERY_MINUTE) return false;
  return minute % 10 === 7 || minute % 10 === 9;
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
  if (cron === MINUTE_FACT_REBUILD_CRON) return (dependencies.runRebuild || runMinuteFactsBackfill)(env, dependencies.rebuild || {});
  if (cron === MINUTE_FACT_LEGACY_CRON) return (dependencies.runLegacy || runMinuteFactsLegacyBackfill)(env, dependencies.legacy || {});
  if (cron === MINUTE_FACT_WORKER_CRON) {
    const minute = scheduledMinute(controller);
    if (minute == null) return { skipped: true, reason: 'scheduled-time-missing' };
    if (minute % 10 === MINUTE_FACT_RECOVERY_MINUTE) {
      if (!enabled(env.MINUTE_FACT_AUTO_REQUEUE_DEAD)) return { skipped: true, reason: 'dead-job-auto-requeue-disabled' };
      return runTracked(env, 'recovery', () => (dependencies.requeueDead || requeueDeadMinuteFactJobs)(env, { limit: env.MINUTE_FACT_DEAD_REQUEUE_LIMIT }));
    }
    if (minute % 2 === 0) return runTracked(env, 'derive', () => (dependencies.runDerive || runMinuteFactDeriveCron)(env, dependencies.derive || {}));
    if (minute % 10 === 7) return runTracked(env, 'rebuild', () => (dependencies.runRebuild || runMinuteFactsBackfill)(env, dependencies.rebuild || {}));
    if (minute % 10 === 9) return runTracked(env, 'legacy', () => (dependencies.runLegacy || runMinuteFactsLegacyBackfill)(env, dependencies.legacy || {}));
    return { skipped: true, reason: 'not-due', minute };
  }
  return { skipped: true, reason: 'unsupported-minute-facts-cron', cron };
}

const rawApp = {
  async scheduled(controller, env, ctx) {
    if (minuteStaggerApplies(controller)) await applyCronStagger(env, 'minute');
    return runMinuteScheduled(controller, env, { ctx });
  },
  async fetch(request, env) {
    if (request.method !== 'GET' || new URL(request.url).pathname !== '/health') return new Response('Not found', { status: 404 });
    const tasks = await readMinuteFactRuntimeState(env);
    const health = tasks.map((task) => ({
      task_name: task.task_name,
      ...minuteFactRuntimeSignals(task, { pendingAgeMs: env.MINUTE_FACT_PENDING_ALERT_MS }),
    }));
    const ok = health.every((task) => !task.has_dead_jobs && !task.pending_stale && !task.last_run_failed);
    return Response.json({ ok, tasks: health });
  },
};

export default createPublicHealthCachedApp(rawApp);
