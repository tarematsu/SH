import { enqueueMinuteDeriveTrigger } from './minute-derive-trigger.js';

const EMPTY_DEPENDENCIES = Object.freeze({});
const SKIPPED_COMMENT_TASK = Object.freeze({ created: false, skipped: true });
let productionModulesPromise = null;
let productionConsumeMinuteFactBatch = null;
let productionEnqueueMinuteFactJob = null;
let readModelModulePromise = null;
let defaultSaveMinuteFactReadModels = null;

function noReceipt() {
  return false;
}

function ignoreReceipt() {}

function skipCommentTask() {
  return SKIPPED_COMMENT_TASK;
}

async function enqueueProductionMinute(activeEnv, payload, options) {
  const accepted = await productionEnqueueMinuteFactJob(activeEnv, payload, options);
  // Queue acceptance is the durable handoff to the one-job derive Worker.
  // Send on duplicate inbox delivery too, so a retry heals a crash between
  // the D1 insert and the original derive Queue send.
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

function injectedHandlers(dependencies, enqueueMinuteFactJob, enqueueDerive) {
  return {
    hasReceipt: noReceipt,
    saveReceipt: ignoreReceipt,
    saveCommentTask: skipCommentTask,
    enqueue: async (activeEnv, payload, options) => {
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
  return consumeMinuteFactBatch(
    batch,
    env,
    injectedHandlers(dependencies, enqueueMinuteFactJob, enqueueDerive),
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
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
