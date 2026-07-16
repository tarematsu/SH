import './fetch-guard.js';

export const OTHER_WORKER_CRON = '*/5 * * * *';

const PRODUCTION_TASK_KEYS = ['buddy', 'host', 'prediction', 'maintenance', 'officialNews', 'snapshotRetention'];
const OFFICIAL_NEWS_DUE_SQL = `SELECT 1 AS due FROM sh_official_news_announcements
  WHERE scheduled_at IS NOT NULL AND (
    (status='scheduled' AND scheduled_at>=? AND scheduled_at<=?) OR status='active'
  ) LIMIT 1`;
const OTHER_CRON_SUCCESS_SQL = `INSERT INTO sh_collector_status (
    collector_id,status,last_attempt_at,last_success_at,last_error,
    failure_code,failure_stage,failure_summary,failure_hint,tracks,changed,updated_at
  ) VALUES ('other-cron','ok',?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?)
  ON CONFLICT(collector_id) DO UPDATE SET
    status='ok',last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,
    last_error=NULL,failure_code=NULL,failure_stage=NULL,failure_summary=NULL,failure_hint=NULL,
    updated_at=excluded.updated_at`;
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

function positiveMs(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
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

export async function officialNewsProbeDue(env, now = Date.now()) {
  if (!env?.OTHER_DB?.prepare) return false;
  const earlyMs = positiveMs(env.OFFICIAL_NEWS_EARLY_WINDOW_MS, 10 * 60_000);
  const lateMs = positiveMs(env.OFFICIAL_NEWS_LATE_WINDOW_MS, 90 * 60_000);
  try {
    const row = await env.OTHER_DB.prepare(OFFICIAL_NEWS_DUE_SQL)
      .bind(now - lateMs, now + earlyMs)
      .first();
    return Boolean(row?.due);
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'official_news_due_check_failed',
      error: String(error?.message || error).slice(0, 500),
    }));
    return false;
  }
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

async function defaultRunner(name) {
  if (name === 'buddy') return (await import('./buddy-playback-scheduler.js')).scheduleBuddyPlayback;
  if (name === 'pages') return (await import('./pages-read-model-refresh.js')).refreshFastPagesReadModels;
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

async function invokeTaskSet(names, controller, env, ctx, dependencies, collectorGate = null) {
  const results = await Promise.allSettled(names.map(
    (name) => invokeTask(name, controller, env, ctx, dependencies, collectorGate),
  ));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) {
    throw new AggregateError(failures.map((result) => result.reason), 'other worker scheduled tasks failed');
  }
  return results.map((result) => result.value);
}

export async function runOfficialNewsWithReconcile(env, now, probe = null, reconcile = null) {
  const activeProbe = probe || (await import('./official-news-probe.js')).runOfficialNewsMonitor;
  const activeReconcile = reconcile || (await import('./official-news-reconcile.js')).reconcileOfficialAnnouncements;
  const { officialNewsConfig } = await import('./official-news-utils.js');
  const probeEnv = probe ? Object.create(env || null) : env;
  const result = await activeProbe(probeEnv, officialNewsConfig(env), now);
  await activeReconcile(env, now);
  return result;
}

export async function runOtherScheduled(controller, env, ctx, dependencies = {}) {
  if (hasInjectedTaskSet(dependencies) && String(controller.cron || '') !== OTHER_WORKER_CRON) {
    const collectorGate = env?.BUDDIES_DB?.prepare
      ? (dependencies.waitForCollector
        ? dependencies.waitForCollector(env, scheduledTimestamp(controller))
        : (await import('./cron-stagger.js')).waitForCollectorCompletion(env, scheduledTimestamp(controller)))
      : null;
    return invokeTaskSet(PRODUCTION_TASK_KEYS, controller, env, ctx, dependencies, collectorGate);
  }

  if (String(controller.cron || '') !== OTHER_WORKER_CRON) {
    return [{ skipped: true, reason: 'unsupported-other-cron', cron: String(controller.cron || '') }];
  }
  const now = scheduledTimestamp(controller);
  const selected = await selectOtherProductionTask(controller, env, dependencies);
  const companion = selected === 'buddy' ? 'host' : selected;
  const names = [];
  const buddyAvailable = Boolean(env?.OTHER_DB?.prepare || typeof dependencies.buddy === 'function');
  const pagesAvailable = Boolean(
    (env?.BUDDIES_DB?.prepare && env?.MINUTE_DB?.prepare && env?.OTHER_DB?.prepare)
      || typeof dependencies.pages === 'function'
  );
  if (buddyAvailable) names.push('buddy');
  if (pagesAvailable && Math.floor(now / 60_000) % 15 === 0) names.push('pages');
  names.push(companion);
  return invokeTaskSet(names, controller, env, ctx, dependencies);
}

async function healthApp() {
  if (!loadedHealthApp) loadedHealthApp = (await import('./other-health.js')).createOtherHealthApp();
  return loadedHealthApp;
}

async function recordOtherCronSuccessFast(env, at = Date.now()) {
  if (!env?.OTHER_DB?.prepare) return false;
  try {
    await env.OTHER_DB.prepare(OTHER_CRON_SUCCESS_SQL).bind(at, at, at).run();
    return true;
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || error))) throw error;
    return (await import('./buddy-health.js')).recordOtherCronSuccess(env, at);
  }
}

async function recordOtherCronFailureLazy(env, error) {
  return (await import('./buddy-health.js')).recordOtherCronFailure(env, error);
}

export async function runOtherCron(controller, env, ctx, options = {}) {
  const health = options.healthApp || loadedHealthApp;
  const recordSuccess = options.recordSuccess || recordOtherCronSuccessFast;
  const recordFailure = options.recordFailure || recordOtherCronFailureLazy;
  try {
    const injectedBroadRun = Boolean(
      options.stagger
      && hasInjectedTaskSet(options.dependencies)
      && String(controller.cron || '') !== OTHER_WORKER_CRON
    );
    if (otherStaggerApplies(controller, env) || injectedBroadRun) {
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
