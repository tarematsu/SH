import {
  enqueueDirectLiveMinuteDerive,
  enqueueMinuteDeriveTrigger,
} from './minute-derive-trigger.js';

const EMPTY_DEPENDENCIES = Object.freeze({});
const SKIPPED_COMMENT_TASK = Object.freeze({ created: false, skipped: true });
let productionModulesPromise = null;
let productionConsumeMinuteFactBatch = null;
let productionEnqueueMinuteFactJob = null;
let readModelModulePromise = null;
let defaultSaveMinuteFactReadModels = null;
let fastStoreModulePromise = null;
let defaultSaveOptimizedMinuteFactWithinBudget = null;

function noReceipt() {
  return false;
}

function ignoreReceipt() {}

function skipCommentTask() {
  return SKIPPED_COMMENT_TASK;
}

function enabled(value) {
  return value === true || value === 1 || /^(1|true|yes|on)$/i.test(String(value || ''));
}

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function liveJobKind(payload, options = {}) {
  return String(options.jobKind || (payload?.rebuild ? 'rebuild' : 'live')).toLowerCase();
}

function inlineLiveDeriveEnabled(env, payload, options = {}) {
  return enabled(env?.LIVE_DERIVE_INLINE_ENABLED)
    && !enabled(env?.LIVE_REVISION_MATERIALIZATION_ENABLED)
    && liveJobKind(payload, options) === 'live'
    && !payload?.rebuild;
}

function directLiveDeriveEnabled(env, payload, options = {}) {
  return enabled(env?.LIVE_DERIVE_DIRECT_QUEUE_ENABLED)
    && !enabled(env?.LIVE_REVISION_MATERIALIZATION_ENABLED)
    && liveJobKind(payload, options) === 'live'
    && !payload?.rebuild;
}

function inlineLiveEnv(env) {
  const active = Object.create(env || null);
  Object.defineProperty(active, 'MINUTE_ENRICHMENT_QUEUE', {
    value: null,
    enumerable: false,
    configurable: true,
  });
  return active;
}

async function saveColdOptimizedMinuteFact(activeEnv, payload) {
  const module = await (fastStoreModulePromise ||= import('./minute-facts-fast-store.js'));
  defaultSaveOptimizedMinuteFactWithinBudget = module.saveOptimizedMinuteFactWithinBudget;
  return defaultSaveOptimizedMinuteFactWithinBudget(activeEnv, payload);
}

function saveDefaultOptimizedMinuteFact(activeEnv, payload) {
  if (defaultSaveOptimizedMinuteFactWithinBudget) {
    return defaultSaveOptimizedMinuteFactWithinBudget(activeEnv, payload);
  }
  return saveColdOptimizedMinuteFact(activeEnv, payload);
}

async function runInlineLiveDerive(write, activeEnv, payload) {
  const result = await write(inlineLiveEnv(activeEnv), payload);
  if (result?.skipped) {
    const error = new Error(`inline live derive skipped: ${String(result.reason || 'unknown')}`);
    error.code = 'MINUTE_LIVE_INLINE_SKIPPED';
    throw error;
  }
  const channelId = integer(payload?.snapshot?.channel_id);
  const observedAt = integer(payload?.observedAt);
  return {
    enqueued: true,
    direct: true,
    inline: true,
    channel_id: channelId,
    minute_at: observedAt == null ? null : Math.floor(observedAt / 60_000) * 60_000,
    job_kind: 'live',
    job_priority: 100,
  };
}

async function enqueueProductionMinute(activeEnv, payload, options) {
  if (inlineLiveDeriveEnabled(activeEnv, payload, options)) {
    return runInlineLiveDerive(saveDefaultOptimizedMinuteFact, activeEnv, payload);
  }
  if (directLiveDeriveEnabled(activeEnv, payload, options)) {
    return enqueueDirectLiveMinuteDerive(activeEnv, payload);
  }
  const accepted = await productionEnqueueMinuteFactJob(activeEnv, payload, options);
  // Rebuild and sparse-revision work retain the D1 ledger for repair.
  await enqueueMinuteDeriveTrigger(activeEnv, accepted);
  return accepted;
}

async function saveColdDefaultReadModels(activeEnv, readModel, jobId) {
  const module = await (readModelModulePromise ||= import('./minute-facts-read-model.js'));
  defaultSaveMinuteFactReadModels = module.saveMinuteFactReadModels;
  return defaultSaveMinuteFactReadModels(activeEnv, readModel, jobId);
}

function saveDefaultReadModels(activeEnv, readModel, jobId) {
  if (!readModel) return undefined;
  if (defaultSaveMinuteFactReadModels) {
    return defaultSaveMinuteFactReadModels(activeEnv, readModel, jobId);
  }
  return saveColdDefaultReadModels(activeEnv, readModel, jobId);
}

const PRODUCTION_HANDLERS = Object.freeze({
  hasReceipt: noReceipt,
  saveReceipt: ignoreReceipt,
  saveCommentTask: skipCommentTask,
  enqueue: enqueueProductionMinute,
  // Rollout compatibility only. Current chained messages have read_model=null
  // because sh-minute-read-model is the sole owner of those writes.
  saveReadModels: saveDefaultReadModels,
});

async function consumeColdProductionMinuteQueue(batch, env) {
  const [queueModule, inboxModule] = await (productionModulesPromise ||= Promise.all([
    import('./minute-facts-queue.js'),
    import('./minute-facts-inbox.js'),
  ]));
  productionEnqueueMinuteFactJob = inboxModule.enqueueMinuteFactJob;
  productionConsumeMinuteFactBatch = queueModule.consumeMinuteFactBatch;
  return productionConsumeMinuteFactBatch(batch, env, PRODUCTION_HANDLERS);
}

function consumeProductionMinuteQueue(batch, env) {
  if (productionConsumeMinuteFactBatch) {
    return productionConsumeMinuteFactBatch(batch, env, PRODUCTION_HANDLERS);
  }
  return consumeColdProductionMinuteQueue(batch, env);
}

function injectedHandlers(
  dependencies,
  enqueueMinuteFactJob,
  enqueueDerive,
  enqueueDirect,
  saveInline,
) {
  return {
    hasReceipt: noReceipt,
    saveReceipt: ignoreReceipt,
    saveCommentTask: skipCommentTask,
    enqueue: async (activeEnv, payload, options) => {
      if (inlineLiveDeriveEnabled(activeEnv, payload, options)) {
        return runInlineLiveDerive(saveInline, activeEnv, payload);
      }
      if (directLiveDeriveEnabled(activeEnv, payload, options)) {
        return enqueueDirect(activeEnv, payload);
      }
      const accepted = await enqueueMinuteFactJob(activeEnv, payload, options);
      await enqueueDerive(activeEnv, accepted);
      return accepted;
    },
    saveReadModels: dependencies.saveMinuteFactReadModels
      ? async (activeEnv, readModel, jobId) => {
          if (readModel) await dependencies.saveMinuteFactReadModels(activeEnv, readModel, jobId);
        }
      : saveDefaultReadModels,
  };
}

async function consumeInjectedMinuteQueue(batch, env, dependencies) {
  const [queueModule, inboxModule] = await Promise.all([
    dependencies.consumeMinuteFactBatch ? null : import('./minute-facts-queue.js'),
    dependencies.enqueueMinuteFactJob ? null : import('./minute-facts-inbox.js'),
  ]);
  const consumeMinuteFactBatch = dependencies.consumeMinuteFactBatch || queueModule.consumeMinuteFactBatch;
  const enqueueMinuteFactJob = dependencies.enqueueMinuteFactJob || inboxModule.enqueueMinuteFactJob;
  const enqueueDerive = dependencies.enqueueMinuteDeriveTrigger || enqueueMinuteDeriveTrigger;
  const enqueueDirect = dependencies.enqueueDirectLiveMinuteDerive || enqueueDirectLiveMinuteDerive;
  const saveInline = dependencies.saveOptimizedMinuteFactWithinBudget
    || saveDefaultOptimizedMinuteFact;
  return consumeMinuteFactBatch(
    batch,
    env,
    injectedHandlers(dependencies, enqueueMinuteFactJob, enqueueDerive, enqueueDirect, saveInline),
  );
}

export function consumeMinuteQueue(batch, env, _ctx, dependencies = EMPTY_DEPENDENCIES) {
  if (dependencies === EMPTY_DEPENDENCIES) {
    return consumeProductionMinuteQueue(batch, env);
  }
  return consumeInjectedMinuteQueue(batch, env, dependencies);
}

export default {
  queue: consumeProductionMinuteQueue,
};
