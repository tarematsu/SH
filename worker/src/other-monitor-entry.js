import './fetch-guard.js';
import { runBuddyPlaybackQueue } from './buddy-playback-entry.js';
import { runHostMonitorQueue } from './host-monitor-entry.js';
import {
  officialNewsProbeDue,
  runOfficialNewsWithReconcile,
  scheduledTimestamp,
} from './other-monitor-support.js';

export const OTHER_MONITOR_CRON = '*/5 * * * *';
const MINUTE_MS = 60_000;
const EMPTY_DEPENDENCIES = Object.freeze({});
const EMPTY_OPTIONS = Object.freeze({});
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
const OTHER_CRON_SUCCESS_SQL = `INSERT INTO sh_collector_status (
    collector_id,status,last_attempt_at,last_success_at,last_error,
    failure_code,failure_stage,failure_summary,failure_hint,tracks,changed,updated_at
  ) VALUES ('other-cron','ok',?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?)
  ON CONFLICT(collector_id) DO UPDATE SET
    status='ok',last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,
    last_error=NULL,failure_code=NULL,failure_stage=NULL,failure_summary=NULL,failure_hint=NULL,
    updated_at=excluded.updated_at`;
let loadedHealthApp = null;
let buddyPipelineModulePromise;
let hostMonitorModulePromise;
let predictionModulePromise;
let buddyHealthModulePromise;

function loadBuddyPipelineModule() {
  buddyPipelineModulePromise ||= import('./buddy-playback-pipeline.js');
  return buddyPipelineModulePromise;
}

function loadHostMonitorModule() {
  hostMonitorModulePromise ||= import('./cloud-host-monitor.js');
  return hostMonitorModulePromise;
}

function loadPredictionModule() {
  predictionModulePromise ||= import('./stream-goal-prediction.js');
  return predictionModulePromise;
}

function loadBuddyHealthModule() {
  buddyHealthModulePromise ||= import('./buddy-health.js');
  return buddyHealthModulePromise;
}

export function otherMonitorTask(now) {
  const minute = Math.floor(now / MINUTE_MS) % 60;
  const buddySlot = minute % 30;
  if (buddySlot === 0 || buddySlot === 5 || buddySlot === 15) return 'buddy';
  if (minute === 10 || minute === 40) return 'prediction';
  if (minute === 20) return 'officialNews';
  return 'host';
}

async function defaultRunner(name) {
  if (name === 'buddy') return (await loadBuddyPipelineModule()).scheduleBuddyPlaybackPipeline;
  if (name === 'host') return (await loadHostMonitorModule()).runCloudHostMonitor;
  if (name === 'prediction') return (await loadPredictionModule()).runStreamGoalPrediction;
  if (name === 'officialNews') return runOfficialNewsWithReconcile;
  throw new Error(`unsupported other monitor task: ${name}`);
}

async function dispatchQueue(env, binding, body) {
  const queue = env?.[binding];
  if (!queue?.send) return null;
  await queue.send(body, JSON_QUEUE_SEND_OPTIONS);
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

async function runTask(name, env, ctx, now, dependencies = EMPTY_DEPENDENCIES) {
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

export async function runOtherMonitorScheduled(controller, env, ctx, dependencies = EMPTY_DEPENDENCIES) {
  const rawCron = controller?.cron;
  const cron = rawCron === OTHER_MONITOR_CRON ? rawCron : String(rawCron || '');
  if (cron !== OTHER_MONITOR_CRON) {
    return [{ skipped: true, reason: 'unsupported-other-monitor-cron', cron }];
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
    return (await loadBuddyHealthModule()).recordOtherCronSuccess(env, at);
  }
}

async function recordOtherCronFailureLazy(env, error) {
  return (await loadBuddyHealthModule()).recordOtherCronFailure(env, error);
}

export async function runOtherMonitorCron(controller, env, ctx, options = EMPTY_OPTIONS) {
  const health = options.healthApp || loadedHealthApp;
  const recordSuccess = options.recordSuccess || recordOtherCronSuccessFast;
  const recordFailure = options.recordFailure || recordOtherCronFailureLazy;
  try {
    const result = await runOtherMonitorScheduled(
      controller,
      env,
      ctx,
      options.dependencies || EMPTY_DEPENDENCIES,
    );
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
  const messages = batch?.messages;
  if (!messages?.length) return;
  const message = messages[0];
  const messageType = String(message?.body?.message_type || '');
  if (messageType === 'buddy-playback-stage') {
    return runBuddyPlaybackQueue(batch, env);
  }
  if (messageType === 'host-monitor-task') {
    return runHostMonitorQueue(batch, env);
  }
  console.error(JSON.stringify({
    event: 'other_monitor_queue_task_failed',
    error: `unsupported monitor queue task: ${messageType || 'unknown'}`,
  }));
  message.retry();
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
