import './fetch-guard.js';
import {
  officialNewsProbeDue,
  runOfficialNewsWithReconcile,
  scheduledTimestamp,
} from './other-monitor-support.js';

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
  const buddySlot = minute % 30;
  if (buddySlot === 0 || buddySlot === 5 || buddySlot === 15) return 'buddy';
  if (minute === 10 || minute === 40) return 'prediction';
  if (minute === 20) return 'officialNews';
  return 'host';
}

async function defaultRunner(name) {
  if (name === 'buddy') return (await import('./buddy-playback-pipeline.js')).scheduleBuddyPlaybackPipeline;
  if (name === 'host') return (await import('./cloud-host-monitor.js')).runCloudHostMonitor;
  if (name === 'prediction') return (await import('./stream-goal-prediction.js')).runStreamGoalPrediction;
  if (name === 'officialNews') return runOfficialNewsWithReconcile;
  throw new Error(`unsupported other monitor task: ${name}`);
}

async function dispatchBuddyPlayback(env, now) {
  if (!env?.BUDDY_PLAYBACK_QUEUE?.send) return null;
  await env.BUDDY_PLAYBACK_QUEUE.send({
    message_type: 'buddy-playback-stage',
    message_version: 1,
    scheduled_at: now,
    observed_at: Date.now(),
  }, { contentType: 'json' });
  return { dispatched: true, task: 'buddy', scheduled_at: now };
}

async function runTask(name, env, ctx, now, dependencies = {}) {
  if (name === 'buddy') {
    const dispatched = await dispatchBuddyPlayback(env, now);
    if (dispatched) return dispatched;
  }
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
  return [await runTask(task, env, ctx, now, dependencies)];
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
