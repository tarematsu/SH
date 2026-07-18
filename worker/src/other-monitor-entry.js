import './fetch-guard.js';
import { runBuddyPlaybackQueue } from './buddy-playback-entry.js';
import { runHostMonitorQueue } from './host-monitor-entry.js';
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

async function dispatchQueue(env, binding, body) {
  if (!env?.[binding]?.send) return null;
  await env[binding].send(body, { contentType: 'json' });
  return body;
}

async function dispatchBuddyPlayback(env, now) {
  const body = await dispatchQueue(env, 'BUDDY_PLAYBACK_QUEUE', {
    message_type: 'buddy-playback-stage',
    message_version: 1,
    scheduled_at: now,
    observed_at: Date.now(),
  });
  return body ? { dispatched: true, task: 'buddy', scheduled_at: now } : null;
}

async function dispatchHostMonitor(env, now) {
  const body = await dispatchQueue(env, 'HOST_MONITOR_QUEUE', {
    message_type: 'host-monitor-task',
    message_version: 1,
    scheduled_at: now,
    observed_at: Date.now(),
  });
  return body ? { dispatched: true, task: 'host', scheduled_at: now } : null;
}

async function runTask(name, env, ctx, now, dependencies = {}) {
  if (name === 'buddy') {
    const dispatched = await dispatchBuddyPlayback(env, now);
    if (dispatched) return dispatched;
  }
  if (name === 'host') {
    const dispatched = await dispatchHostMonitor(env, now);
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

export async function runOtherMonitorQueue(batch, env) {
  const messageType = String(batch?.messages?.[0]?.body?.message_type || '');
  if (messageType === 'buddy-playback-stage') {
    return runBuddyPlaybackQueue(batch, env);
  }
  if (messageType === 'host-monitor-task') {
    return runHostMonitorQueue(batch, env);
  }
  for (const message of batch?.messages || []) {
    console.error(JSON.stringify({
      event: 'other_monitor_queue_task_failed',
      error: `unsupported monitor queue task: ${String(message?.body?.message_type || 'unknown')}`,
    }));
    message.retry();
  }
}

async function healthApp() {
  if (!loadedHealthApp) loadedHealthApp = (await import('./other-health.js')).createOtherHealthApp();
  return loadedHealthApp;
}

export default {
  scheduled: runOtherMonitorCron,
  queue: runOtherMonitorQueue,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return (await healthApp()).fetch(request, env, ctx);
    }
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
