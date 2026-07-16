import { enqueueMinuteDeriveTrigger } from './minute-derive-trigger.js';

export async function consumeMinuteQueue(batch, env, _ctx, dependencies = {}) {
  const [queueModule, inboxModule] = await Promise.all([
    dependencies.consumeMinuteFactBatch ? Promise.resolve(null) : import('./minute-facts-queue.js'),
    dependencies.enqueueMinuteFactJob ? Promise.resolve(null) : import('./minute-facts-inbox.js'),
  ]);
  const consumeMinuteFactBatch = dependencies.consumeMinuteFactBatch || queueModule.consumeMinuteFactBatch;
  const enqueueMinuteFactJob = dependencies.enqueueMinuteFactJob || inboxModule.enqueueMinuteFactJob;
  const enqueueDerive = dependencies.enqueueMinuteDeriveTrigger || enqueueMinuteDeriveTrigger;
  return consumeMinuteFactBatch(batch, env, {
    hasReceipt: async () => false,
    saveReceipt: async () => {},
    saveCommentTask: async () => ({ created: false, skipped: true }),
    enqueue: async (activeEnv, payload, options) => {
      const accepted = await enqueueMinuteFactJob(activeEnv, payload, options);
      // Queue acceptance is the durable handoff to the one-job derive Worker.
      // Send on duplicate inbox delivery too, so a retry heals a crash between
      // the D1 insert and the original derive Queue send.
      await enqueueDerive(activeEnv, accepted);
      return accepted;
    },
    // Rollout compatibility only. Current chained messages have read_model=null
    // because sh-read-model is the sole owner of those writes.
    saveReadModels: async (activeEnv, readModel, jobId) => {
      if (!readModel) return;
      const save = dependencies.saveMinuteFactReadModels
        || (await import('./minute-facts-read-model.js')).saveMinuteFactReadModels;
      await save(activeEnv, readModel, jobId);
    },
  });
}

export default {
  queue: consumeMinuteQueue,
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
