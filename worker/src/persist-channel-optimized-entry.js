import { withAppleMusicFreeD1 } from '../../site/functions/lib/apple-music-d1-pruner.js';
import { processPersistenceTask } from './persist-channel-entry.js';
import {
  processOptimizedQueueLikesTask,
  QUEUE_STAGE_LIKES_WRITE,
} from './persist-likes-stages.js';

const RETRY_30_SECONDS = Object.freeze({ delaySeconds: 30 });
const EMPTY_DEPENDENCIES = Object.freeze({});

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
    likes_changed: result?.likes_changed === true || result?.likesChanged === true,
    likes_write_deferred: result?.likes_write_deferred === true,
    likes_write_complete: result?.likes_write_complete === true,
    next_cursor: result?.next_cursor ?? null,
    materialization_recorded: result?.materialization_recorded === true,
    metadata_deferred: result?.metadata_deferred === true,
    finalization_deferred: result?.finalization_deferred === true,
  }));
}

function isOptimizedLikesTask(body) {
  return body?.message_type === 'stationhead-persistence-task'
    && body?.task === 'queue'
    && (body?.stage === 'likes' || body?.stage === QUEUE_STAGE_LIKES_WRITE);
}

async function processPersistenceBatch(batch, env, dependencies = EMPTY_DEPENDENCIES) {
  const messages = batch.messages;
  if (!messages?.length) return;
  const message = messages[0];
  const activeEnv = withAppleMusicFreeD1(env);
  try {
    const result = isOptimizedLikesTask(message.body)
      ? await processOptimizedQueueLikesTask(activeEnv, message.body, dependencies)
      : await processPersistenceTask(activeEnv, message.body, dependencies);
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

export { processPersistenceBatch };

export default {
  queue: processPersistenceBatch,
};
