import './fetch-guard.js';

export const OTHER_HOST_CRON = '*/5 * * * *';
export const OTHER_BUDDY_CRON = '0 */3 * * *';
export const OTHER_PREDICTION_CRON = '10,40 * * * *';
export const OTHER_OFFICIAL_NEWS_CRON = '20 * * * *';
export const OTHER_MAINTENANCE_CRON = '30 * * * *';
export const OTHER_RETENTION_CRON = '50 * * * *';

const PRODUCTION_TASK_KEYS = ['buddy', 'host', 'prediction', 'maintenance', 'officialNews', 'snapshotRetention'];
const TASK_BY_CRON = new Map([
  [OTHER_HOST_CRON, 'host'],
  [OTHER_BUDDY_CRON, 'buddy'],
  [OTHER_PREDICTION_CRON, 'prediction'],
  [OTHER_OFFICIAL_NEWS_CRON, 'officialNews'],
  [OTHER_MAINTENANCE_CRON, 'maintenance'],
  [OTHER_RETENTION_CRON, 'snapshotRetention'],
]);
let loadedHealthApp = null;

export function scheduledTimestamp(controller, fallback = Date.now()) {
  const value = Number(controller?.scheduledTime);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function otherTaskForCron(cron) {
  return TASK_BY_CRON.get(String(cron || '')) || null;
}

export function otherStaggerApplies(controller = {}) {
  const task = otherTaskForCron(controller.cron);
  return task === 'maintenance' || task === 'snapshotRetention';
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
  // Keep the historical injected-test isolation without restoring the costly
  // D1 statement Proxy on production calls.
  const probeEnv = probe ? Object.create(env || null) : env;
  const result = await activeProbe(probeEnv, officialNewsConfig(env), now);
  await activeReconcile(env, now);
  return result;
}

export async function runOtherScheduled(controller, env, ctx, dependencies = {}) {
  if (hasInjectedTaskSet(dependencies) && !otherTaskForCron(controller.cron)) {
    // Preserve the broad injected mode used by integration tests and manual
    // diagnostics. Production uses only the explicit cron routes above.
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

  const name = otherTaskForCron(controller.cron);
  if (!name) return [{ skipped: true, reason: 'unsupported-other-cron', cron: String(controller.cron || '') }];
  return [await invokeTask(name, controller, env, ctx, dependencies)];
}

async function healthApp() {
  if (!loadedHealthApp) loadedHealthApp = (await import('./other-health.js')).createOtherHealthApp();
  return loadedHealthApp;
}

export async function runOtherCron(controller, env, ctx, options = {}) {
  const health = options.healthApp || loadedHealthApp;
  const healthModule = (!options.recordSuccess || !options.recordFailure)
    ? await import('./buddy-health.js')
    : null;
  const recordSuccess = options.recordSuccess || healthModule.recordOtherCronSuccess;
  const recordFailure = options.recordFailure || healthModule.recordOtherCronFailure;
  try {
    if (otherStaggerApplies(controller)) {
      const stagger = options.stagger || (await import('./cron-stagger.js')).applyCronStagger;
      await stagger(env, 'other');
    }
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
