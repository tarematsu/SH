import './fetch-guard.js';
import { officialNewsProbeDue, runOfficialNewsWithReconcile, scheduledTimestamp } from './other-entry.js';

export const OTHER_MONITOR_CRON = '*/5 * * * *';
const OTHER_CRON_SUCCESS_SQL = `INSERT INTO sh_collector_status (
    collector_id,status,last_attempt_at,last_success_at,last_error,
    failure_code,failure_stage,failure_summary,failure_hint,tracks,changed,updated_at
  ) VALUES ('other-cron','ok',?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?)
  ON CONFLICT(collector_id) DO UPDATE SET
    status='ok',last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,
    last_error=NULL,failure_code=NULL,failure_stage=NULL,failure_summary=NULL,failure_hint=NULL,
    updated_at=excluded.updated_at`;
let loadedHealthApp = null;

export function otherMonitorTask(now) {
  const minute = new Date(now).getUTCMinutes();
  if (minute === 10 || minute === 40) return 'prediction';
  if (minute === 20) return 'officialNews';
  return 'host';
}

async function defaultRunner(name) {
  if (name === 'buddy') return (await import('./buddy-playback-scheduler.js')).scheduleBuddyPlayback;
  if (name === 'host') return (await import('./cloud-host-monitor.js')).runCloudHostMonitor;
  if (name === 'prediction') return (await import('./stream-goal-prediction.js')).runStreamGoalPrediction;
  if (name === 'officialNews') return runOfficialNewsWithReconcile;
  throw new Error(`unsupported other monitor task: ${name}`);
}

async function runTask(name, env, ctx, now, dependencies = {}) {
  const runner = dependencies[name] || await defaultRunner(name);
  if (name === 'buddy') return runner(env, ctx, now);
  if (name === 'host') return runner(env);
  return runner(env, now);
}

export async function runOtherMonitorScheduled(controller, env, ctx, dependencies = {}) {
  if (String(controller?.cron || '') !== OTHER_MONITOR_CRON) {
    return [{ skipped: true, reason: 'unsupported-other-monitor-cron', cron: String(controller?.cron || '') }];
  }
  const now = scheduledTimestamp(controller);
  let task = otherMonitorTask(now);
  const due = dependencies.officialNewsDue || officialNewsProbeDue;
  if (task === 'host' && await due(env, now)) task = 'officialNews';

  const names = [];
  if (env?.OTHER_DB?.prepare || typeof dependencies.buddy === 'function') names.push('buddy');
  names.push(task);
  const results = await Promise.allSettled(names.map((name) => runTask(name, env, ctx, now, dependencies)));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) {
    throw new AggregateError(failures.map((result) => result.reason), 'other monitor tasks failed');
  }
  return results.map((result) => result.value);
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

export async function runOtherMonitorCron(controller, env, ctx, options = {}) {
  const health = options.healthApp || loadedHealthApp;
  const recordSuccess = options.recordSuccess || recordOtherCronSuccessFast;
  const recordFailure = options.recordFailure || recordOtherCronFailureLazy;
  try {
    const result = await runOtherMonitorScheduled(controller, env, ctx, options.dependencies);
    await recordSuccess(env);
    return result;
  } catch (error) {
    await recordFailure(env, error).catch(() => {});
    throw error;
  } finally {
    health?.invalidateHealthCache?.();
  }
}

async function healthApp() {
  if (!loadedHealthApp) loadedHealthApp = (await import('./other-health.js')).createOtherHealthApp();
  return loadedHealthApp;
}

export default {
  scheduled: runOtherMonitorCron,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return (await healthApp()).fetch(request, env, ctx);
    }
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
