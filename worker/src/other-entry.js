import './fetch-guard.js';

const PRODUCTION_TASK_KEYS = ['buddy', 'host', 'prediction', 'maintenance', 'officialNews', 'snapshotRetention'];
let loadedHealthApp = null;

export function scheduledTimestamp(controller, fallback = Date.now()) {
  const value = Number(controller?.scheduledTime);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positiveMinutes(value, fallbackMs) {
  const milliseconds = Number(value ?? fallbackMs);
  const safe = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : fallbackMs;
  return Math.max(1, Math.round(safe / 60_000));
}

function productionTask(now, env = {}) {
  const absoluteMinute = Math.floor(now / 60_000);
  const buddyMinutes = positiveMinutes(env.BUDDY_PLAYBACK_INTERVAL_MS, 3 * 60 * 60_000);
  const predictionMinutes = positiveMinutes(env.STREAM_GOAL_PREDICTION_INTERVAL_MS, 30 * 60_000);
  const newsMinutes = positiveMinutes(env.OFFICIAL_NEWS_CHECK_INTERVAL_MS, 60 * 60_000);
  const maintenanceMinutes = positiveMinutes(env.DATA_MAINTENANCE_INTERVAL_MS, 60 * 60_000);
  const retentionMinutes = positiveMinutes(env.SNAPSHOT_RETENTION_INTERVAL_MS, 60 * 60_000);

  if (absoluteMinute % buddyMinutes === 0) return 'buddy';
  if ((absoluteMinute - 10) % predictionMinutes === 0) return 'prediction';
  if ((absoluteMinute - 20) % newsMinutes === 0) return 'officialNews';
  if ((absoluteMinute - 30) % maintenanceMinutes === 0) return 'maintenance';
  if ((absoluteMinute - 50) % retentionMinutes === 0) return 'snapshotRetention';
  return 'host';
}

function hasInjectedTaskSet(dependencies = {}) {
  return PRODUCTION_TASK_KEYS.some((key) => typeof dependencies[key] === 'function');
}

async function defaultRunner(name) {
  if (name === 'buddy') return (await import('./buddy-playback-scheduler.js')).scheduleBuddyPlayback;
  if (name === 'host') return (await import('./cloud-host-monitor.js')).runCloudHostMonitor;
  if (name === 'prediction') return (await import('./stream-goal-prediction.js')).runStreamGoalPrediction;
  if (name === 'maintenance') return (await import('./scheduled-maintenance.js')).runScheduledMaintenance;
  if (name === 'officialNews') return runOfficialNewsWithReconcile;
  if (name === 'snapshotRetention') return (await import('./snapshot-retention.js')).pruneOldSnapshotsSafely;
  throw new Error(`unsupported other worker task: ${name}`);
}

async function invokeTask(name, controller, env, ctx, dependencies, collectorGate = null) {
  const now = scheduledTimestamp(controller);
  const runner = dependencies[name] || await defaultRunner(name);
  if ((name === 'maintenance' || name === 'snapshotRetention') && env?.BUDDIES_DB?.prepare) {
    const gate = collectorGate || (await import('./cron-stagger.js')).waitForCollectorCompletion(env, now);
    const collector = await gate;
    if (!collector.ready) {
      return { skipped: true, reason: collector.reason, targetMinute: collector.targetMinute };
    }
  }
  if (name === 'buddy') return runner(env, ctx, now);
  if (name === 'host') return runner(env);
  return runner(env, now);
}

// If probe throws, reconcile is skipped. The normal probe catches and records
// its own failures, so rejection here is reserved for injected/test probes.
export async function runOfficialNewsWithReconcile(env, now, probe = null, reconcile = null) {
  const activeProbe = probe || (await import('./official-news-probe.js')).runOfficialNewsMonitor;
  const activeReconcile = reconcile || (await import('./official-news-reconcile.js')).reconcileOfficialAnnouncements;
  const { officialNewsConfig } = await import('./official-news-utils.js');
  // Extra D1 operations are acceptable here; avoid the scheduled D1 Proxy and
  // its SQL classification/traps on every statement.
  const result = await activeProbe(env, officialNewsConfig(env), now);
  await activeReconcile(env, now);
  return result;
}

export async function runOtherScheduled(controller, env, ctx, dependencies = {}) {
  if (hasInjectedTaskSet(dependencies)) {
    // Preserve the broad injected mode used by integration tests and manual
    // diagnostics. Production takes the single-task route below.
    const collectorGate = env?.BUDDIES_DB?.prepare
      ? (dependencies.waitForCollector
        ? dependencies.waitForCollector(env, scheduledTimestamp(controller))
        : (await import('./cron-stagger.js')).waitForCollectorCompletion(env, scheduledTimestamp(controller)))
      : null;
    const results = await Promise.allSettled(PRODUCTION_TASK_KEYS.map(
      (name) => invokeTask(name, controller, env, ctx, dependencies, collectorGate),
    ));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'other worker scheduled tasks failed');
    return results.map((result) => result.value);
  }

  const name = productionTask(scheduledTimestamp(controller), env);
  return [await invokeTask(name, controller, env, ctx, dependencies)];
}

async function healthApp() {
  if (!loadedHealthApp) loadedHealthApp = (await import('./other-health.js')).createOtherHealthApp();
  return loadedHealthApp;
}

export async function runOtherCron(controller, env, ctx, options = {}) {
  const cronModule = options.stagger ? null : await import('./cron-stagger.js');
  const stagger = options.stagger || cronModule.applyCronStagger;
  const health = options.healthApp || loadedHealthApp;
  const healthModule = (!options.recordSuccess || !options.recordFailure)
    ? await import('./buddy-health.js')
    : null;
  const recordSuccess = options.recordSuccess || healthModule.recordOtherCronSuccess;
  const recordFailure = options.recordFailure || healthModule.recordOtherCronFailure;
  try {
    await stagger(env, 'other');
    const result = await runOtherScheduled(controller, env, ctx, options.dependencies);
    await recordSuccess(env);
    return result;
  } catch (error) {
    await recordFailure(env, error).catch(() => {});
    throw error;
  } finally {
    health?.invalidateHealthCache?.();
  }
}

export default {
  scheduled: runOtherCron,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return (await healthApp()).fetch(request, env, ctx);
    }
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
