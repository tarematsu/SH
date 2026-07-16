import minuteWorker, { runCommittedMetadataEnrichment } from './minute-entry.js';

const EVERY_MINUTE_CRON = '* * * * *';
const LEGACY_DERIVE_CRON = '*/2 * * * *';

export async function consumeMinuteQueue(batch, env, ctx) {
  const [{ consumeMinuteFactBatch }, { enqueueMinuteFactJob }] = await Promise.all([
    import('./minute-facts-queue.js'),
    import('./minute-facts-inbox.js'),
  ]);
  const metadataJobs = [];
  const newJobIds = new Set();
  const result = await consumeMinuteFactBatch(batch, env, {
    hasReceipt: async () => false,
    saveReceipt: async () => {},
    // Old Queue messages may still carry collectComments=true during rollout.
    // The buddies collector now owns Stationhead comment collection, so minute
    // must never create a follow-up task that would call production1 again.
    saveCommentTask: async () => ({ created: false, skipped: true }),
    enqueue: async (activeEnv, payload, options) => {
      const accepted = await enqueueMinuteFactJob(activeEnv, payload, options);
      if (accepted?.enqueued) {
        newJobIds.add(`minute-fact:${accepted.channel_id}:${accepted.minute_at}`);
      }
      return accepted;
    },
    // The split ingest Worker deliberately removes read_model from current
    // minute-fact messages because sh-read-model is now the sole writer. Keep
    // legacy compatibility without loading the large read-model module on the
    // normal split-pipeline path.
    saveReadModels: async (activeEnv, readModel, jobId) => {
      if (!readModel) return;
      const { saveMinuteFactReadModels } = await import('./minute-facts-read-model.js');
      await saveMinuteFactReadModels(activeEnv, readModel, jobId);
    },
    onCommitted(job) {
      if (newJobIds.has(job.jobId)
          && job.options.enrichTrackMetadata
          && job.payload.queue?.tracks?.length) {
        metadataJobs.push(job);
      }
    },
  });
  if (metadataJobs.length) {
    const task = runCommittedMetadataEnrichment(env, metadataJobs);
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
