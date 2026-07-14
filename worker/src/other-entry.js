import './fetch-guard.js';
import { scheduleBuddyPlayback, scheduledTimestamp } from './buddy-playback-scheduler.js';
import { recordOtherCronFailure, recordOtherCronSuccess } from './buddy-health.js';
import { applyCronStagger } from './cron-stagger.js';
import { runCloudHostMonitor } from './cloud-host-monitor.js';
import { withScheduledD1Optimizations } from './d1-scheduled-optimizer.js';
import { reconcileOfficialAnnouncements } from './official-news-reconcile.js';
import { runOfficialNewsMonitor } from './official-news-probe.js';
import { officialNewsConfig } from './official-news-utils.js';
import { createOtherHealthApp } from './other-health.js';
import { runScheduledMaintenance } from './scheduled-maintenance.js';
import { pruneOldSnapshotsSafely } from './snapshot-retention.js';
import { runStreamGoalPrediction } from './stream-goal-prediction.js';

const otherHealthApp = createOtherHealthApp();

// If probe throws, reconcile is skipped (reconcile only makes sense once the
// probe has actually run). In production runOfficialNewsMonitor catches its
// own errors and never rejects, so this only matters for injected probes.
export async function runOfficialNewsWithReconcile(
  env,
  now,
  probe = runOfficialNewsMonitor,
  reconcile = reconcileOfficialAnnouncements,
) {
  const result = await probe(withScheduledD1Optimizations(env, Date.now, 'OTHER_DB'), officialNewsConfig(env), now);
  await reconcile(env, now);
  return result;
}

export async function runOtherScheduled(controller, env, ctx, dependencies = {}) {
  const now = scheduledTimestamp(controller);
  const tasks = [
    (dependencies.buddy || scheduleBuddyPlayback)(env, ctx, now),
    (dependencies.host || runCloudHostMonitor)(env),
    (dependencies.prediction || runStreamGoalPrediction)(env, now),
    (dependencies.maintenance || runScheduledMaintenance)(env, now),
    (dependencies.officialNews || runOfficialNewsWithReconcile)(env, now),
    (dependencies.snapshotRetention || pruneOldSnapshotsSafely)(env, now),
  ];
  const results = await Promise.allSettled(tasks);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'other worker scheduled tasks failed');
  return results.map((result) => result.value);
}

export async function runOtherCron(controller, env, ctx, options = {}) {
  const stagger = options.stagger || applyCronStagger;
  const healthApp = options.healthApp || otherHealthApp;
  const recordSuccess = options.recordSuccess || recordOtherCronSuccess;
  const recordFailure = options.recordFailure || recordOtherCronFailure;
  try {
    await stagger(env, 'other');
    const result = await runOtherScheduled(controller, env, ctx, options.dependencies);
    await recordSuccess(env);
    return result;
  } catch (error) {
    await recordFailure(env, error).catch(() => {});
    throw error;
  } finally {
    healthApp.invalidateHealthCache();
  }
}

export default {
  async scheduled(controller, env, ctx) {
    return runOtherCron(controller, env, ctx);
  },
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return otherHealthApp.fetch(request, env, ctx);
    }
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
