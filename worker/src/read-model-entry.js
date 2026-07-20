import {
  readModelNeedsHydration,
  readModelNeedsPreservation,
} from './read-model-metadata-plan.js';
import { writePreparedReadModel } from './read-model-stages.js';

const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
const EMPTY_DEPENDENCIES = Object.freeze({});

export {
  readModelNeedsHydration,
  readModelNeedsPreservation,
};

function deferredReadModelTask(readModel) {
  if (readModelNeedsHydration(readModel)) return 'read-model-hydration';
  if (readModelNeedsPreservation(readModel)) return 'read-model-preserve';
  return null;
}

export async function processReadModelMessage(env, body, dependencies = EMPTY_DEPENDENCIES) {
  if (body?.message_type !== 'stationhead-read-model' || Number(body?.message_version) !== 1) {
    throw new Error('unsupported read model message');
  }
  const observedAt = Number(body.observed_at) || null;
  const readModel = body.read_model;
  const metadataQueue = env?.TRACK_METADATA_QUEUE;
  const deferredTask = metadataQueue?.send ? deferredReadModelTask(readModel) : null;
  if (deferredTask) {
    await metadataQueue.send({
      message_type: 'stationhead-track-metadata',
      message_version: 1,
      task: deferredTask,
      job_id: body.job_id,
      observed_at: observedAt,
      read_model: readModel,
    }, JSON_QUEUE_SEND_OPTIONS);
    console.log(JSON.stringify({
      event: deferredTask === 'read-model-hydration'
        ? 'read_model_hydration_deferred'
        : 'read_model_preservation_deferred',
      observed_at: observedAt,
    }));
    return { deferred: true };
  }
  const write = dependencies.writePreparedReadModel || writePreparedReadModel;
  await write(env, readModel);
  console.log(JSON.stringify({
    event: 'read_model_updated',
    observed_at: observedAt,
  }));
  return { deferred: false };
}

export async function processReadModelBatch(batch, env, dependencies = EMPTY_DEPENDENCIES) {
  const messages = batch.messages;
  if (!messages?.length) return;
  const message = messages[0];
  try {
    await processReadModelMessage(env, message.body, dependencies);
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({
      event: 'read_model_update_failed',
      error: String(error?.message || error).slice(0, 800),
    }));
    message.retry();
  }
}

export default {
  queue: processReadModelBatch,
};
