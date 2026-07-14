import { applyCronStagger } from './cron-stagger.js';
import { sanitizeFailureDetail } from './collector-failure.js';
import { configFromEnv } from './collector-config.js';
import { ingest } from './collector-ingest.js';
import { runMinuteFactsBackfill } from './minute-facts-backfill.js';
import { runMinuteFactDeriveCron } from './minute-facts-derive.js';
import { runMinuteCommentTasks } from './minute-comments.js';
import { requeueDeadMinuteFactJobs } from './minute-facts-inbox.js';
import { consumeMinuteFactBatch } from './minute-facts-queue.js';
import {
  hasMinuteFactQueueReceipt,
  saveMinuteFactQueueReceipt,
  saveMinuteFactReadModels,
} from './minute-facts-read-model.js';
import { minuteFactRuntimeSignals, readMinuteFactRuntimeState, recordMinuteFactRuntimeState } from './minute-facts-runtime-state.js';
import { createPublicHealthCachedApp } from './public-health-cache.js';
import { enrichTracks as sharedEnrichTracks } from './shared.js';

export const MINUTE_FACT_DERIVE_CRON = '*/2 * * * *';
export const MINUTE_FACT_REBUILD_CRON = '7,17,27,37,47,57 * * * *';
export const MINUTE_FACT_WORKER_CRON = '* * * * *';
export const MINUTE_FACT_RECOVERY_MINUTE = 5;
const ACTIVE_HEALTH_TASKS = new Set(['comments', 'derive', 'recovery', 'rebuild']);

export function activeMinuteHealthTasks(tasks = []) {
  return tasks.filter((task) => ACTIVE_HEALTH_TASKS.has(String(task?.task_name || '')));
}

function scheduledMinute(controller = {}) {
  const timestamp = Number(controller.scheduledTime);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).getUTCMinutes();
}

export function minuteStaggerApplies(controller = {}) {
  const cron = String(controller.cron || '');
  if (cron === MINUTE_FACT_REBUILD_CRON) return true;
  if (cron !== MINUTE_FACT_WORKER_CRON) return false;
  const minute = scheduledMinute(controller);
  return minute != null && (minute % 10 === 7 || minute % 10 === 9);
}

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function withSourceDatabase(env, binding) {
  const source = env?.[binding];
  if (!source) return env;
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === 'DB') return source;
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      return property === 'DB' || Reflect.has(target, property);
    },
  });
}

export async function runCommittedMetadataEnrichment(env, jobs, dependencies = {}) {
  const sourceEnv = withSourceDatabase(env, 'BUDDIES_DB');
  if (!env?.BUDDIES_DB || !sourceEnv?.DB) {
    console.warn(JSON.stringify({
      event: 'minute_track_metadata_enrichment_skipped',
      reason: 'buddies-db-binding-missing',
      jobs: jobs.length,
    }));
    return;
  }
  const enrichTracks = dependencies.enrichTracks || sharedEnrichTracks;
  const writeIngest = dependencies.ingest || ingest;
  const config = dependencies.config || configFromEnv(sourceEnv);
  for (const job of jobs) {
    try {
      const saved = await enrichTracks(
        sourceEnv,
        writeIngest,
        job.payload.queue,
        job.payload.observedAt,
        config,
      );
      console.log(JSON.stringify({
        event: 'minute_track_metadata_enriched',
        job_id: job.jobId,
        saved: Number(saved || 0),
      }));
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'minute_track_metadata_enrichment_failed',
        job_id: job.jobId,
        error: sanitizeFailureDetail(error?.message || error),
      }));
    }
  }
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

function runDerive(env, dependencies) {
  return (dependencies.runDerive || runMinuteFactDeriveCron)(
    withSourceDatabase(env, 'BUDDIES_DB'),
    dependencies.derive || {},
  );
}

function runRebuild(env, dependencies) {
  return (dependencies.runRebuild || runMinuteFactsBackfill)(
    withSourceDatabase(env, 'BUDDIES_DB'),
    dependencies.rebuild || {},
  );
}

async function runOptionalCommentTasks(env, dependencies) {
  try {
    return await (dependencies.runComments || runMinuteCommentTasks)(
      env,
      dependencies.comments || {},
    );
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'minute_comment_tasks_failed',
      error: sanitizeFailureDetail(error?.message || error),
    }));
    return { skipped: true, reason: 'task-runner-failed', failed: 1 };
  }
}

export async function runMinuteScheduled(controller = {}, env, dependencies = {}) {
  const cron = String(controller.cron || '');
  if (cron === MINUTE_FACT_DERIVE_CRON) return runTracked(env, 'derive', () => runDerive(env, dependencies));
  if (cron === MINUTE_FACT_REBUILD_CRON) return runTracked(env, 'rebuild', () => runRebuild(env, dependencies));
  if (cron === MINUTE_FACT_WORKER_CRON) {
    await runTracked(env, 'comments', () => runOptionalCommentTasks(env, dependencies));
    const minute = scheduledMinute(controller);
    if (minute == null) return { skipped: true, reason: 'scheduled-time-missing' };
    if (minute % 10 === MINUTE_FACT_RECOVERY_MINUTE) {
      if (!enabled(env.MINUTE_FACT_AUTO_REQUEUE_DEAD)) return { skipped: true, reason: 'dead-job-auto-requeue-disabled' };
      return runTracked(env, 'recovery', () => (dependencies.requeueDead || requeueDeadMinuteFactJobs)(env, { limit: env.MINUTE_FACT_DEAD_REQUEUE_LIMIT }));
    }
    if (minute % 2 === 0) return runTracked(env, 'derive', () => runDerive(env, dependencies));
    if (minute % 10 === 7) return runTracked(env, 'rebuild', () => runRebuild(env, dependencies));
    return { skipped: true, reason: 'not-due', minute };
  }
  return { skipped: true, reason: 'unsupported-minute-facts-cron', cron };
}

const rawApp = {
  async queue(batch, env, ctx) {
    const metadataJobs = [];
    const result = await consumeMinuteFactBatch(batch, env, {
      hasReceipt: hasMinuteFactQueueReceipt,
      saveReceipt: saveMinuteFactQueueReceipt,
      saveReadModels: saveMinuteFactReadModels,
      onCommitted(job) {
        if (job.options.enrichTrackMetadata && job.payload.queue?.tracks?.length) {
          metadataJobs.push(job);
        }
      },
    });
    if (metadataJobs.length) {
      const task = runCommittedMetadataEnrichment(env, metadataJobs);
      if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(task);
      else void task;
    }
    return result;
  },
  async scheduled(controller, env, ctx) {
    if (minuteStaggerApplies(controller)) await applyCronStagger(env, 'minute');
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
