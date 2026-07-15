export const MINUTE_FACT_DERIVE_CRON = '*/2 * * * *';
export const MINUTE_FACT_MAINTENANCE_CRON = '5,7,9,15,17,19,25,27,29,35,37,39,45,47,49,55,57,59 * * * *';
// Legacy direct routes remain supported for manual invocation and rollback.
export const MINUTE_FACT_RECOVERY_CRON = '5,15,25,35,45,55 * * * *';
export const MINUTE_FACT_REBUILD_CRON = '7,17,27,37,47,57 * * * *';
export const MINUTE_FACT_SYNC_CRON = '9,19,29,39,49,59 * * * *';
export const MINUTE_FACT_WORKER_CRON = MINUTE_FACT_DERIVE_CRON;
export const MINUTE_FACT_RECOVERY_MINUTE = 5;

const ACTIVE_HEALTH_TASKS = new Set(['derive', 'recovery', 'rebuild', 'sync']);
let healthCache = null;

function sanitizeFailureDetail(value) {
  return String(value?.message || value || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
}

export function activeMinuteHealthTasks(tasks = []) {
  return tasks.filter((task) => ACTIVE_HEALTH_TASKS.has(String(task?.task_name || '')));
}

function scheduledMinute(controller = {}) {
  const timestamp = Number(controller.scheduledTime);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).getUTCMinutes();
}

export function minuteMaintenanceTask(controller = {}) {
  const cron = String(controller.cron || '');
  if (cron === MINUTE_FACT_RECOVERY_CRON) return 'recovery';
  if (cron === MINUTE_FACT_REBUILD_CRON) return 'rebuild';
  if (cron === MINUTE_FACT_SYNC_CRON) return 'sync';
  if (cron !== MINUTE_FACT_MAINTENANCE_CRON) return null;
  const minute = scheduledMinute(controller);
  if (minute == null) return null;
  const slot = ((minute % 10) + 10) % 10;
  if (slot === 5) return 'recovery';
  if (slot === 7) return 'rebuild';
  if (slot === 9) return 'sync';
  return null;
}

export function minuteStaggerApplies(controller = {}) {
  const task = minuteMaintenanceTask(controller);
  return task === 'rebuild' || task === 'sync';
}

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function withSourceDatabase(env, binding) {
  const source = env?.[binding];
  if (!source) return env;
  const active = Object.create(env || null);
  Object.defineProperty(active, 'DB', { value: source, enumerable: false });
  return active;
}

async function runtimeStateModule() {
  return import('./minute-facts-runtime-state.js');
}

export async function runCommittedMetadataEnrichment(env, jobs, dependencies = {}) {
  const sourceEnv = withSourceDatabase(env, 'MINUTE_DB');
  if (!env?.MINUTE_DB || !sourceEnv?.DB) {
    console.warn(JSON.stringify({
      event: 'minute_track_metadata_enrichment_skipped',
      reason: 'minute-db-binding-missing',
      jobs: jobs.length,
    }));
    return;
  }

  const [{ configFromEnv }, { ingest }, { enrichTracks: sharedEnrichTracks }] = await Promise.all([
    dependencies.config ? Promise.resolve({ configFromEnv: () => dependencies.config }) : import('./collector-config.js'),
    dependencies.ingest ? Promise.resolve({ ingest: dependencies.ingest }) : import('./collector-ingest.js'),
    dependencies.enrichTracks ? Promise.resolve({ enrichTracks: dependencies.enrichTracks }) : import('./shared.js'),
  ]);
  const config = dependencies.config || configFromEnv(sourceEnv);

  for (const job of jobs) {
    try {
      const saved = await sharedEnrichTracks(
        sourceEnv,
        ingest,
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
        error: sanitizeFailureDetail(error),
      }));
    }
  }
}

async function runTracked(env, task, action, dependencies = {}) {
  const startedAt = Date.now();
  try {
    const result = await action();
    if (env?.MINUTE_DB) {
      const record = dependencies.recordRuntimeState
        || (await runtimeStateModule()).recordMinuteFactRuntimeState;
      await record(env, task, result, { startedAt });
    }
    return result;
  } catch (error) {
    if (env?.MINUTE_DB) {
      const record = dependencies.recordRuntimeState
        || (await runtimeStateModule()).recordMinuteFactRuntimeState;
      await record(env, task, { error }, { startedAt, success: false }).catch(() => {});
    }
    throw error;
  }
}

async function runDerive(env, dependencies) {
  const runner = dependencies.runDerive
    || (await import('./minute-facts-derive.js')).runMinuteFactDeriveCron;
  return runner(withSourceDatabase(env, 'BUDDIES_DB'), dependencies.derive || {});
}

async function runRebuild(env, dependencies) {
  const runner = dependencies.runRebuild
    || (await import('./minute-facts-backfill.js')).runMinuteFactsBackfill;
  return runner(withSourceDatabase(env, 'BUDDIES_DB'), dependencies.rebuild || {});
}

async function runSync(env, dependencies) {
  const runner = dependencies.runSync
    || (await import('./buddies-facts-sync.js')).runBuddiesFactsSync;
  return runner(withSourceDatabase(env, 'BUDDIES_DB'), dependencies.sync || {});
}

async function runRecovery(env, dependencies) {
  if (!enabled(env.MINUTE_FACT_AUTO_REQUEUE_DEAD)) {
    return { skipped: true, reason: 'dead-job-auto-requeue-disabled' };
  }
  const runner = dependencies.requeueDead
    || (await import('./minute-facts-inbox.js')).requeueDeadMinuteFactJobs;
  return runner(env, { limit: env.MINUTE_FACT_DEAD_REQUEUE_LIMIT });
}

export async function runMinuteScheduled(controller = {}, env, dependencies = {}) {
  const cron = String(controller.cron || '');
  if (cron === MINUTE_FACT_DERIVE_CRON) {
    return runTracked(env, 'derive', () => runDerive(env, dependencies), dependencies);
  }

  const maintenanceTask = minuteMaintenanceTask(controller);
  if (maintenanceTask === 'recovery') {
    return runTracked(env, 'recovery', () => runRecovery(env, dependencies), dependencies);
  }
  if (maintenanceTask === 'rebuild') {
    return runTracked(env, 'rebuild', () => runRebuild(env, dependencies), dependencies);
  }
  if (maintenanceTask === 'sync') {
    if (dependencies.collectorReady === false) return { skipped: true, reason: 'collector-not-ready' };
    if (!env?.BUDDIES_DB && !env?.DB) return { skipped: true, reason: 'source-db-binding-missing' };
    return runTracked(env, 'sync', () => runSync(env, dependencies), dependencies);
  }
  return { skipped: true, reason: 'unsupported-minute-facts-cron', cron };
}

export async function runMinuteScheduledWithCollectorPriority(
  controller = {},
  env = {},
  ctx = null,
  dependencies = {},
) {
  if (!minuteStaggerApplies(controller)) {
    return runMinuteScheduled(controller, env, { ...dependencies, ctx, collectorReady: true });
  }

  const cronModule = (!dependencies.applyStagger || !dependencies.waitForCollector)
    ? await import('./cron-stagger.js')
    : null;
  const stagger = dependencies.applyStagger || cronModule.applyCronStagger;
  const waitForCollector = dependencies.waitForCollector || cronModule.waitForCollectorCompletion;
  await stagger(env, 'minute');

  let collector;
  let collectorError = null;
  try {
    collector = await waitForCollector(env, controller?.scheduledTime);
  } catch (error) {
    collectorError = sanitizeFailureDetail(error);
    collector = { ready: false, reason: 'collector-check-failed', targetMinute: null };
  }

  if (!collector.ready) {
    console.warn(JSON.stringify({
      event: 'minute_collector_priority_wait_expired',
      reason: collector.reason || 'collector-not-ready',
      target_minute: collector.targetMinute ?? null,
      error: collectorError,
    }));
  }
  return runMinuteScheduled(controller, env, {
    ...dependencies,
    ctx,
    collectorReady: collector.ready,
  });
}

async function consumeQueue(batch, env, ctx) {
  const [{ consumeMinuteFactBatch }, { saveMinuteFactReadModels }, { enqueueMinuteFactJob }] = await Promise.all([
    import('./minute-facts-queue.js'),
    import('./minute-facts-read-model.js'),
    import('./minute-facts-inbox.js'),
  ]);
  const metadataJobs = [];
  const newJobIds = new Set();
  const result = await consumeMinuteFactBatch(batch, env, {
    hasReceipt: async () => false,
    saveReceipt: async () => {},
    // Old Queue messages may still carry collectComments=true during rollout.
    // The buddies collector now owns Stationhead comment collection, so minute
    // must never create a follow-up task that would call production1 again.
    saveCommentTask: async () => ({ created: false, skipped: true }),
    enqueue: async (activeEnv, payload, options) => {
      const accepted = await enqueueMinuteFactJob(activeEnv, payload, options);
      if (accepted?.enqueued) {
        newJobIds.add(`minute-fact:${accepted.channel_id}:${accepted.minute_at}`);
      }
      return accepted;
    },
    saveReadModels: saveMinuteFactReadModels,
    onCommitted(job) {
      if (newJobIds.has(job.jobId)
          && job.options.enrichTrackMetadata
          && job.payload.queue?.tracks?.length) {
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
}

async function healthResponse(request, env) {
  if (request.method !== 'GET' || new URL(request.url).pathname !== '/health') {
    return new Response('Not found', { status: 404 });
  }
  const now = Date.now();
  if (healthCache?.expiresAt > now) {
    return new Response(healthCache.body, {
      headers: { 'content-type': 'application/json; charset=UTF-8', 'x-health-cache': 'hit' },
    });
  }
  const { minuteFactRuntimeSignals, readMinuteFactRuntimeState } = await runtimeStateModule();
  const tasks = activeMinuteHealthTasks(await readMinuteFactRuntimeState(env));
  const health = tasks.map((task) => ({
    task_name: task.task_name,
    ...minuteFactRuntimeSignals(task, { pendingAgeMs: env.MINUTE_FACT_PENDING_ALERT_MS }),
  }));
  const body = JSON.stringify({
    ok: health.every((task) => !task.has_dead_jobs && !task.pending_stale && !task.last_run_failed),
    tasks: health,
  });
  healthCache = { body, expiresAt: now + Math.max(1_000, Number(env.PUBLIC_HEALTH_CACHE_MS || 60_000)) };
  return new Response(body, { headers: { 'content-type': 'application/json; charset=UTF-8' } });
}

export default {
  queue: consumeQueue,
  scheduled: runMinuteScheduledWithCollectorPriority,
  fetch: healthResponse,
};
