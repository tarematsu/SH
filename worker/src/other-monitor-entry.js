import './fetch-guard.js';
import { officialNewsProbeDue, runOfficialNewsWithReconcile, scheduledTimestamp } from './other-entry.js';

export const OTHER_MONITOR_CRON = '*/5 * * * *';

function scheduledTask(now) {
  const minute = new Date(now).getUTCMinutes();
  if (minute === 10 || minute === 40) return 'prediction';
  if (minute === 20) return 'officialNews';
  return 'host';
}

async function runTask(name, env, ctx, now) {
  if (name === 'buddy') {
    const { scheduleBuddyPlayback } = await import('./buddy-playback-scheduler.js');
    return scheduleBuddyPlayback(env, ctx, now);
  }
  if (name === 'host') {
    const { runCloudHostMonitor } = await import('./cloud-host-monitor.js');
    return runCloudHostMonitor(env);
  }
  if (name === 'prediction') {
    const { runStreamGoalPrediction } = await import('./stream-goal-prediction.js');
    return runStreamGoalPrediction(env, now);
  }
  if (name === 'officialNews') return runOfficialNewsWithReconcile(env, now);
  throw new Error(`unsupported other monitor task: ${name}`);
}

export async function runOtherMonitorCron(controller, env, ctx) {
  if (String(controller?.cron || '') !== OTHER_MONITOR_CRON) {
    return [{ skipped: true, reason: 'unsupported-other-monitor-cron' }];
  }
  const now = scheduledTimestamp(controller);
  let task = scheduledTask(now);
  if (task === 'host' && await officialNewsProbeDue(env, now)) task = 'officialNews';
  const names = ['buddy', task];
  const results = await Promise.allSettled(names.map((name) => runTask(name, env, ctx, now)));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'other monitor tasks failed');
  return results.map((result) => result.value);
}

export default {
  scheduled: runOtherMonitorCron,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      const { createOtherHealthApp } = await import('./other-health.js');
      return createOtherHealthApp().fetch(request, env, ctx);
    }
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
