import minuteWorker, {
  minuteMaintenanceTask,
  runMinuteScheduledWithCollectorPriority,
} from './minute-entry.js';
import { pendingMinuteDeriveTriggers } from './minute-derive-trigger.js';
import {
  markSparseRevisionRecoveryDispatched,
  pendingSparseRevisionTasks,
} from './minute-revision-recovery.js';

export const MINUTE_DERIVE_DISPATCH_CRON = '* * * * *';

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

async function recordDeriveDispatchState(env, summary, startedAt, dependencies = {}) {
  if (!env?.MINUTE_DB) return;
  const [inboxModule, runtimeModule] = await Promise.all([
    dependencies.stats ? Promise.resolve(null) : import('./minute-facts-inbox.js'),
    dependencies.record ? Promise.resolve(null) : import('./minute-facts-runtime-state.js'),
  ]);
  const stats = dependencies.stats || inboxModule.minuteFactInboxStats;
  const record = dependencies.record || runtimeModule.recordMinuteFactRuntimeState;
  let snapshot = {};
  try { snapshot = await stats(env); } catch {}
  Object.assign(summary, snapshot);
  await record(env, 'derive', {
    processed: 0,
    failed: 0,
    ...snapshot,
  }, { startedAt });
}

async function sendDeriveMessages(env, messages) {
  if (!messages.length) return;
  if (typeof env.MINUTE_DERIVE_QUEUE.sendBatch === 'function') {
    await env.MINUTE_DERIVE_QUEUE.sendBatch(messages.map((body) => ({ body, contentType: 'json' })));
    return;
  }
  await Promise.all(messages.map((body) => env.MINUTE_DERIVE_QUEUE.send(body, { contentType: 'json' })));
}

export async function dispatchPendingMinuteFacts(env, dependencies = {}, ctx = null) {
  if (!env?.MINUTE_DERIVE_QUEUE?.send && typeof env?.MINUTE_DERIVE_QUEUE?.sendBatch !== 'function') {
    throw new Error('MINUTE_DERIVE_QUEUE binding is missing');
  }
  const startedAt = Date.now();
  const loadFacts = dependencies.load || pendingMinuteDeriveTriggers;
  const loadRevisions = dependencies.loadRevisionRecovery || pendingSparseRevisionTasks;
  const factLimit = positiveInteger(env.DERIVE_DISPATCH_LIMIT, 5, 20);
  const recoveryLimit = positiveInteger(env.DERIVE_REVISION_RECOVERY_LIMIT, 1, 5);
  const [triggers, revisionRecoveries] = await Promise.all([
    loadFacts(env, { limit: factLimit }),
    loadRevisions(env, { limit: recoveryLimit, now: startedAt }),
  ]);
  await sendDeriveMessages(env, [...triggers, ...revisionRecoveries]);
  if (revisionRecoveries.length) {
    const mark = dependencies.markRevisionRecovery || markSparseRevisionRecoveryDispatched;
    await mark(
      env,
      revisionRecoveries.map((task) => task?.revision?.revision_id),
      startedAt,
    );
  }
  const summary = {
    event: 'minute_derive_dispatch',
    dispatched: triggers.length,
    revision_recoveries: revisionRecoveries.length,
    limit: factLimit,
    recovery_limit: recoveryLimit,
  };
  const stateTask = recordDeriveDispatchState(env, summary, startedAt, dependencies).catch((error) => {
    console.warn(JSON.stringify({
      event: 'minute_derive_dispatch_state_failed',
      error: String(error?.message || error).slice(0, 800),
    }));
  });
  if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(stateTask);
  else await stateTask;
  console.log(JSON.stringify(summary));
  return summary;
}

async function dispatchRebuild(controller, env, ctx, dependencies = {}) {
  if (!env?.MINUTE_REBUILD_QUEUE?.send) {
    return runMinuteScheduledWithCollectorPriority(controller, env, ctx, dependencies);
  }
  const cronModule = await import('./cron-stagger.js');
  await (dependencies.applyStagger || cronModule.applyCronStagger)(env, 'minute');
  const collector = await (dependencies.waitForCollector || cronModule.waitForCollectorCompletion)(
    env,
    controller?.scheduledTime,
  );
  if (!collector?.ready) {
    return { skipped: true, reason: collector?.reason || 'collector-not-ready' };
  }
  const scheduledAt = Number(controller?.scheduledTime) || Date.now();
  const runId = `minute-rebuild:${scheduledAt}`;
  await env.MINUTE_REBUILD_QUEUE.send({
    message_type: 'minute-rebuild-stage',
    message_version: 1,
    run_id: runId,
    stage: 'gap-scan',
    scheduled_at: scheduledAt,
  }, { contentType: 'json' });
  const result = { event: 'minute_rebuild_dispatched', run_id: runId, dispatched: 1 };
  console.log(JSON.stringify(result));
  return result;
}

export default {
  fetch: minuteWorker.fetch,
  scheduled(controller, env, ctx) {
    if (String(controller?.cron || '') === MINUTE_DERIVE_DISPATCH_CRON) {
      return dispatchPendingMinuteFacts(env, {}, ctx);
    }
    if (minuteMaintenanceTask(controller) === 'rebuild') {
      return dispatchRebuild(controller, env, ctx);
    }
    return runMinuteScheduledWithCollectorPriority(controller, env, ctx);
  },
};
