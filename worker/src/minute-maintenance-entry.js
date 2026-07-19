import {
  minuteMaintenanceTask,
  runMinuteScheduledWithCollectorPriority,
} from './minute-entry.js';
import { pendingMinuteDeriveTriggers } from './minute-derive-trigger.js';
import {
  markSparseRevisionRecoveryDispatched,
  pendingSparseRevisionTasks,
} from './minute-revision-recovery.js';
import optimizedMaintenanceWorker from './minute-maintenance-optimized-entry.js';

export const MINUTE_DERIVE_DISPATCH_CRON = '* * * * *';

const EMPTY_DEPENDENCIES = Object.freeze({});
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
let deriveDispatchStateDependenciesPromise = null;
let cronStaggerModulePromise = null;

function defaultDeriveDispatchStateDependencies() {
  deriveDispatchStateDependenciesPromise ||= Promise.all([
    import('./minute-facts-inbox.js'),
    import('./minute-facts-runtime-state.js'),
  ]).then(([inboxModule, runtimeModule]) => ({
    stats: inboxModule.minuteFactInboxStats,
    record: runtimeModule.recordMinuteFactRuntimeState,
  }));
  return deriveDispatchStateDependenciesPromise;
}

function cronStaggerModule() {
  cronStaggerModulePromise ||= import('./cron-stagger.js');
  return cronStaggerModulePromise;
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function scheduledTimestamp(controller) {
  const value = controller?.scheduledTime;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : Date.now();
  }
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now();
}

function isDeriveDispatchCron(controller) {
  const value = controller?.cron;
  return value === MINUTE_DERIVE_DISPATCH_CRON
    || String(value || '') === MINUTE_DERIVE_DISPATCH_CRON;
}

async function recordDeriveDispatchState(env, summary, startedAt, dependencies = EMPTY_DEPENDENCIES) {
  if (!env?.MINUTE_DB) return;
  let stats = dependencies.stats;
  let record = dependencies.record;
  if (!stats || !record) {
    const defaults = await defaultDeriveDispatchStateDependencies();
    stats ||= defaults.stats;
    record ||= defaults.record;
  }
  let snapshot = {};
  try { snapshot = await stats(env); } catch {}
  Object.assign(summary, snapshot);
  await record(env, 'derive', {
    processed: 0,
    failed: 0,
    ...snapshot,
  }, { startedAt });
}

function rebuildDeriveMessage(message) {
  return String(message?.job_kind || message?.job?.job_kind || '').toLowerCase() === 'rebuild'
    || message?.revision?.rebuild === true;
}

function appendMessage(target, message) {
  target[target.length] = message;
}

function splitDeriveMessages(triggers, revisionRecoveries) {
  const live = [];
  const rebuild = [];
  for (let index = 0; index < triggers.length; index += 1) {
    const message = triggers[index];
    appendMessage(rebuildDeriveMessage(message) ? rebuild : live, message);
  }
  for (let index = 0; index < revisionRecoveries.length; index += 1) {
    const message = revisionRecoveries[index];
    appendMessage(rebuildDeriveMessage(message) ? rebuild : live, message);
  }
  return { live, rebuild };
}

async function sendQueueMessages(queue, messages, bindingName) {
  const messageCount = messages.length;
  if (!messageCount) return;
  if (!queue?.send && typeof queue?.sendBatch !== 'function') {
    throw new Error(`${bindingName} binding is missing`);
  }

  if (typeof queue.sendBatch === 'function') {
    const batch = new Array(messageCount);
    for (let index = 0; index < messageCount; index += 1) {
      batch[index] = { body: messages[index], contentType: 'json' };
    }
    await queue.sendBatch(batch);
    return;
  }

  const sends = new Array(messageCount);
  for (let index = 0; index < messageCount; index += 1) {
    sends[index] = queue.send(messages[index], JSON_QUEUE_SEND_OPTIONS);
  }
  await Promise.all(sends);
}

async function sendDeriveMessages(env, triggers, revisionRecoveries) {
  const routed = splitDeriveMessages(triggers, revisionRecoveries);
  const liveQueue = env?.MINUTE_LIVE_DERIVE_QUEUE || env?.MINUTE_DERIVE_QUEUE;
  const rebuildQueue = env?.MINUTE_DERIVE_QUEUE || liveQueue;

  if (liveQueue === rebuildQueue) {
    const messageCount = routed.live.length + routed.rebuild.length;
    const messages = new Array(messageCount);
    let offset = 0;
    for (let index = 0; index < routed.live.length; index += 1) {
      messages[offset] = routed.live[index];
      offset += 1;
    }
    for (let index = 0; index < routed.rebuild.length; index += 1) {
      messages[offset] = routed.rebuild[index];
      offset += 1;
    }
    await sendQueueMessages(liveQueue, messages, 'MINUTE_DERIVE_QUEUE');
  } else {
    await Promise.all([
      sendQueueMessages(liveQueue, routed.live, 'MINUTE_LIVE_DERIVE_QUEUE'),
      sendQueueMessages(rebuildQueue, routed.rebuild, 'MINUTE_DERIVE_QUEUE'),
    ]);
  }
  return routed;
}

export async function dispatchPendingMinuteFacts(env, dependencies = EMPTY_DEPENDENCIES, ctx = null) {
  if (!env?.MINUTE_LIVE_DERIVE_QUEUE?.send
      && typeof env?.MINUTE_LIVE_DERIVE_QUEUE?.sendBatch !== 'function'
      && !env?.MINUTE_DERIVE_QUEUE?.send
      && typeof env?.MINUTE_DERIVE_QUEUE?.sendBatch !== 'function') {
    throw new Error('minute derive Queue binding is missing');
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
  const routed = await sendDeriveMessages(env, triggers, revisionRecoveries);
  if (revisionRecoveries.length) {
    const mark = dependencies.markRevisionRecovery || markSparseRevisionRecoveryDispatched;
    const revisionIds = new Array(revisionRecoveries.length);
    for (let index = 0; index < revisionRecoveries.length; index += 1) {
      revisionIds[index] = revisionRecoveries[index]?.revision?.revision_id;
    }
    await mark(env, revisionIds, startedAt);
  }
  const summary = {
    event: 'minute_derive_dispatch',
    dispatched: triggers.length,
    revision_recoveries: revisionRecoveries.length,
    live_messages: routed.live.length,
    rebuild_messages: routed.rebuild.length,
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

async function dispatchRebuild(controller, env, ctx, dependencies = EMPTY_DEPENDENCIES) {
  if (!env?.MINUTE_REBUILD_QUEUE?.send) {
    return runMinuteScheduledWithCollectorPriority(controller, env, ctx, dependencies);
  }
  const staggerModule = await cronStaggerModule();
  await (dependencies.applyStagger || staggerModule.applyCronStagger)(env, 'minute');
  const collector = await (dependencies.waitForCollector || staggerModule.waitForCollectorCompletion)(
    env,
    controller?.scheduledTime,
  );
  if (!collector?.ready) {
    return { skipped: true, reason: collector?.reason || 'collector-not-ready' };
  }
  const scheduledAt = scheduledTimestamp(controller);
  const runId = `minute-rebuild:${scheduledAt}`;
  await env.MINUTE_REBUILD_QUEUE.send({
    message_type: 'minute-rebuild-stage',
    message_version: 1,
    run_id: runId,
    stage: 'gap-scan',
    scheduled_at: scheduledAt,
  }, JSON_QUEUE_SEND_OPTIONS);
  const result = { event: 'minute_rebuild_dispatched', run_id: runId, dispatched: 1 };
  console.log(JSON.stringify(result));
  return result;
}

export default optimizedMaintenanceWorker;
