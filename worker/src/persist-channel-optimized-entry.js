import { processPersistenceTask } from './persist-channel-entry.js';

const RETRY_30_SECONDS = Object.freeze({ delaySeconds: 30 });

function logPersistenceResult(result) {
  console.log(JSON.stringify({
    event: 'persistence_task_completed',
    task: result?.task ?? null,
    stage: result?.stage ?? null,
    observed_at: result?.observed_at ?? null,
    total_track_count: result?.total_track_count ?? null,
    materialized_track_count: result?.materialized_track_count ?? null,
    structure_write_deferred: result?.structure_write_deferred === true,
    likes_deferred: result?.likes_deferred === true,
    materialization_recorded: result?.materialization_recorded === true,
    metadata_deferred: result?.metadata_deferred === true,
    finalization_deferred: result?.finalization_deferred === true,
  }));
}

async function processPersistenceBatch(batch, env) {
  const messages = batch.messages;
  if (!messages?.length) return;
  const message = messages[0];
  try {
    const result = await processPersistenceTask(env, message.body);
    logPersistenceResult(result);
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({
      event: 'persistence_task_failed',
      error: String(error?.message || error).slice(0, 800),
    }));
    message.retry(RETRY_30_SECONDS);
  }
}

export default {
  queue: processPersistenceBatch,
};
