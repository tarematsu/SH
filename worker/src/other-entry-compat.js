import {
  officialNewsProbeDue,
  runOfficialNewsWithReconcile,
} from './other-monitor-support.js';

export { officialNewsProbeDue, runOfficialNewsWithReconcile };

export const OTHER_WORKER_CRON = '*/5 * * * *';

const PRODUCTION_TASK_KEYS = [
  'buddy',
  'host',
  'prediction',
  'maintenance',
  'officialNews',
  'snapshotRetention',
];

function scheduledTimestamp(controller, fallback = Date.now()) {
  const value = Number(controller?.scheduledTime);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positiveMinutes(value, fallbackMs) {
  const milliseconds = Number(value ?? fallbackMs);
  const safe = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : fallbackMs;
  return Math.max(1, Math.round(safe / 60_000));
}

export function otherProductionTask(now, env = {}) {
  const absoluteMinute = Math.floor(now / 60_000);
  const minute = ((absoluteMinute % 60) + 60) % 60;
  const buddyMinutes = positiveMinutes(env.BUDDY_PLAYBACK_INTERVAL_MS, 3 * 60 * 60_000);

  if (minute === 0 && absoluteMinute % buddyMinutes === 0) return 'buddy';
  if (minute === 10 || minute === 40) return 'prediction';
  if (minute === 20) return 'officialNews';
  if (minute === 30) return 'maintenance';
  if (minute === 50) return 'snapshotRetention';
  return 'host';
}

export async function selectOtherProductionTask(controller, env, dependencies = {}) {
  const now = scheduledTimestamp(controller);
  const scheduled = otherProductionTask(now, env);
  if (scheduled !== 'host') return scheduled;
  const due = dependencies.officialNewsDue || officialNewsProbeDue;
  return await due(env, now) ? 'officialNews' : scheduled;
}

export function otherStaggerApplies(controller = {}, env = {}) {
  const task = otherProductionTask(scheduledTimestamp(controller), env);
  return task === 'maintenance' || task === 'snapshotRetention';
}

function hasInjectedTaskSet(dependencies = {}) {
  return PRODUCTION_TASK_KEYS.some((key) => typeof dependencies[key] === 'function');
}

async function invokeInjectedTask(name, controller, env, ctx, dependencies) {
  const runner = dependencies[name];
  if (typeof runner !== 'function') {
    throw new Error(`legacy compatibility task requires an injected ${name} runner`);
  }
  const now = scheduledTimestamp(controller);
  if (name === 'buddy') return runner(env, ctx, now);
  if (name === 'host') return runner(env);
  return runner(env, now);
}

async function invokeInjectedTaskSet(names, controller, env, ctx, dependencies) {
  const results = await Promise.allSettled(
    names.map((name) => invokeInjectedTask(name, controller, env, ctx, dependencies)),
  );
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) {
    throw new AggregateError(
      failures.map((result) => result.reason),
      'other worker scheduled tasks failed',
    );
  }
  return results.map((result) => result.value);
}

export async function runOtherScheduled(controller, env, ctx, dependencies = {}) {
  const cron = String(controller?.cron || '');
  if (hasInjectedTaskSet(dependencies) && cron !== OTHER_WORKER_CRON) {
    return invokeInjectedTaskSet(PRODUCTION_TASK_KEYS, controller, env, ctx, dependencies);
  }
  if (cron !== OTHER_WORKER_CRON) {
    return [{ skipped: true, reason: 'unsupported-other-cron', cron }];
  }

  const now = scheduledTimestamp(controller);
  const selected = await selectOtherProductionTask(controller, env, dependencies);
  const companion = selected === 'buddy' ? 'host' : selected;
  const names = [];
  if (typeof dependencies.buddy === 'function') names.push('buddy');
  if (typeof dependencies.pages === 'function' && Math.floor(now / 60_000) % 15 === 0) {
    names.push('pages');
  }
  names.push(companion);
  return invokeInjectedTaskSet(names, controller, env, ctx, dependencies);
}

export async function runOtherCron(controller, env, ctx, options = {}) {
  const health = options.healthApp;
  const dependencies = options.dependencies || {};
  const recordSuccess = options.recordSuccess || (async () => {});
  const recordFailure = options.recordFailure || (async () => {});
  try {
    const injectedBroadRun = Boolean(
      options.stagger
      && hasInjectedTaskSet(dependencies)
      && String(controller?.cron || '') !== OTHER_WORKER_CRON
    );
    if (otherStaggerApplies(controller, env) || injectedBroadRun) {
      await options.stagger?.(env, 'other');
    }
    const result = await runOtherScheduled(controller, env, ctx, dependencies);
    await recordSuccess(env);
    return result;
  } catch (error) {
    await recordFailure(env, error).catch(() => {});
    throw error;
  } finally {
    health?.invalidateHealthCache?.();
  }
}
