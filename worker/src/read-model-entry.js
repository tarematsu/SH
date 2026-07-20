import {
  readModelMetadataTask,
  readModelNeedsHydration,
  readModelNeedsPreservation,
} from './read-model-metadata-plan.js';
import {
  prepareReadModelForWrite,
  writePreparedReadModel,
} from './read-model-stages.js';

const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
const EMPTY_DEPENDENCIES = Object.freeze({});

export {
  readModelNeedsHydration,
  readModelNeedsPreservation,
};

function deferredEvent(task) {
  if (task === 'read-model-hydration') return 'read_model_hydration_deferred';
  if (task === 'read-model-preserve') return 'read_model_preservation_deferred';
  return 'read_model_write_deferred';
}

export async function processReadModelMessage(env, body, dependencies = EMPTY_DEPENDENCIES) {
  if (body?.message_type !== 'stationhead-read-model' || Number(body?.message_version) !== 1) {
    throw new Error('unsupported read model message');
  }
  const observedAt = Number(body.observed_at) || null;
  const readModel = body.read_model;
  const metadataQueue = env?.TRACK_METADATA_QUEUE;
  const metadataTask = readModelMetadataTask(readModel);
  const delegatedTask = metadataTask
    || (!env?.MINUTE_DB && !dependencies.writePreparedReadModel ? 'read-model-write' : null);
  if (metadataQueue?.send && delegatedTask) {
    await metadataQueue.send({
      message_type: 'stationhead-track-metadata',
      message_version: 1,
      task: delegatedTask,
      job_id: body.job_id,
      observed_at: observedAt,
      read_model: readModel,
    }, JSON_QUEUE_SEND_OPTIONS);
    console.log(JSON.stringify({
      event: deferredEvent(delegatedTask),
      observed_at: observedAt,
    }));
    return { deferred: true };
  }
  let prepared = readModel;
  if (!metadataQueue?.send && metadataTask) {
    const prepare = dependencies.prepareReadModelForWrite || prepareReadModelForWrite;
    prepared = await prepare(env, readModel);
  }
  const write = dependencies.writePreparedReadModel || writePreparedReadModel;
  await write(env, prepared);
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
