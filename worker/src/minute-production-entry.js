import minuteWorker, { runCommittedMetadataEnrichment } from './minute-entry.js';

const EVERY_MINUTE_CRON = '* * * * *';
const LEGACY_DERIVE_CRON = '*/2 * * * *';

export async function consumeMinuteQueue(batch, env, ctx, dependencies = {}) {
  const [queueModule, inboxModule] = await Promise.all([
    dependencies.consumeMinuteFactBatch ? Promise.resolve(null) : import('./minute-facts-queue.js'),
    dependencies.enqueueMinuteFactJob ? Promise.resolve(null) : import('./minute-facts-inbox.js'),
  ]);
  const consumeMinuteFactBatch = dependencies.consumeMinuteFactBatch || queueModule.consumeMinuteFactBatch;
  const enqueueMinuteFactJob = dependencies.enqueueMinuteFactJob || inboxModule.enqueueMinuteFactJob;
  const metadataJobs = [];
  const result = await consumeMinuteFactBatch(batch, env, {
    hasReceipt: async () => false,
    saveReceipt: async () => {},
    // Old Queue messages may still carry collectComments=true during rollout.
    // The dedicated comments Worker owns Stationhead comment collection, so
    // minute must never create a follow-up task that would call production1.
    saveCommentTask: async () => ({ created: false, skipped: true }),
    enqueue: async (activeEnv, payload, options) => {
      const accepted = await enqueueMinuteFactJob(activeEnv, payload, options);
      if (accepted?.enqueued
          && options.enrichTrackMetadata
          && payload.queue?.tracks?.length) {
        metadataJobs.push({
          jobId: `minute-fact:${accepted.channel_id}:${accepted.minute_at}`,
          payload,
          options,
        });
      }
      return accepted;
    },
    // The split ingest Worker deliberately removes read_model from current
    // minute-fact messages because sh-read-model is now the sole writer. Keep
    // legacy compatibility without loading the large read-model module on the
    // normal split-pipeline path.
    saveReadModels: async (activeEnv, readModel, jobId) => {
      if (!readModel) return;
      const save = dependencies.saveMinuteFactReadModels
        || (await import('./minute-facts-read-model.js')).saveMinuteFactReadModels;
      await save(activeEnv, readModel, jobId);
    },
  });
  // Schedule metadata from the successful durable inbox INSERT, rather than
  // from the later ACK hook. A legacy read-model failure may retry the Queue
  // message, but must not erase the one accepted job's optional metadata work.
  if (metadataJobs.length) {
    const enrich = dependencies.runCommittedMetadataEnrichment || runCommittedMetadataEnrichment;
    const task = enrich(env, metadataJobs);
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(task);
    else void task;
  }
  return result;
}

export default {
  ...minuteWorker,
  queue: consumeMinuteQueue,
  scheduled(controller, env, ctx) {
    const activeController = String(controller?.cron || '') === EVERY_MINUTE_CRON
      ? { ...controller, cron: LEGACY_DERIVE_CRON }
      : controller;
    return minuteWorker.scheduled(activeController, env, ctx);
  },
};