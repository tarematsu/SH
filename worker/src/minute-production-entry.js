import { enqueueMinuteDeriveTrigger } from './minute-derive-trigger.js';

const EMPTY_DEPENDENCIES = Object.freeze({});
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
  return { created: false, skipped: true };
}

async function enqueueProductionMinute(activeEnv, payload, options) {
  const accepted = await productionEnqueueMinuteFactJob(activeEnv, payload, options);
  // Queue acceptance is the durable handoff to the one-job derive Worker.
  // Send on duplicate inbox delivery too, so a retry heals a crash between
  // the D1 insert and the original derive Queue send.
  await enqueueMinuteDeriveTrigger(activeEnv, accepted);
  return accepted;
}

async function saveDefaultReadModels(activeEnv, readModel, jobId) {
  if (!readModel) return;
  if (!defaultSaveMinuteFactReadModels) {
    const module = await (readModelModulePromise ||= import('./minute-facts-read-model.js'));
    defaultSaveMinuteFactReadModels = module.saveMinuteFactReadModels;
  }
  await defaultSaveMinuteFactReadModels(activeEnv, readModel, jobId);
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

async function consumeProductionMinuteQueue(batch, env) {
  if (!productionConsumeMinuteFactBatch || !productionEnqueueMinuteFactJob) {
    const [queueModule, inboxModule] = await (productionModulesPromise ||= Promise.all([
      import('./minute-facts-queue.js'),
      import('./minute-facts-inbox.js'),
    ]));
    productionConsumeMinuteFactBatch = queueModule.consumeMinuteFactBatch;
    productionEnqueueMinuteFactJob = inboxModule.enqueueMinuteFactJob;
  }
  return productionConsumeMinuteFactBatch(batch, env, PRODUCTION_HANDLERS);
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

export async function consumeMinuteQueue(batch, env, _ctx, dependencies = EMPTY_DEPENDENCIES) {
  if (dependencies === EMPTY_DEPENDENCIES) {
    return consumeProductionMinuteQueue(batch, env);
  }

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

export default {
  queue: consumeMinuteQueue,
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
