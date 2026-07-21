import { logSampledSuccess } from './sampled-success-log.js';

const RETRY_30_SECONDS = Object.freeze({ delaySeconds: 30 });
const EMPTY_DEPENDENCIES = Object.freeze({});

let fallbackModulePromise;
let likesPlanModulePromise;
let likesWriteModulePromise;
let structureModulePromise;

function likesBudgetEnvironment(env) {
  if (env?.QUEUE_LIKES_REPAIR_ENABLED != null) return env;
  const active = Object.create(env);
  Object.defineProperty(active, 'QUEUE_LIKES_REPAIR_ENABLED', {
    value: false,
    enumerable: false,
    configurable: true,
  });
  return active;
}

async function processStructureTask(env, body, dependencies) {
  const module = await (structureModulePromise ||= import('./persist-structure-budget-entry.js'));
  return module.processBudgetedQueueStructureTask(env, body, dependencies);
}

async function processLikesPlanTask(env, body, dependencies) {
  const module = await (likesPlanModulePromise ||= import('./persist-likes-plan-entry.js'));
  const activeDependencies = dependencies?.prepareQueueLikesPersistence
    ? {
        ...dependencies,
        prepareQueueLikesPersistence: (_activeEnv, value, observedAt) => (
          dependencies.prepareQueueLikesPersistence(env.DB, value, observedAt)
        ),
      }
    : dependencies;
  return module.processOptimizedQueueLikesPlanTask(
    likesBudgetEnvironment(env),
    body,
    activeDependencies,
  );
}

async function processLikesWriteTask(env, body, dependencies) {
  const module = await (likesWriteModulePromise ||= import('./persist-likes-stages.js'));
  return module.processOptimizedQueueLikesTask(env, body, dependencies);
}

async function processFallbackTask(env, body, dependencies) {
  const module = await (fallbackModulePromise ||= import('./persist-channel-entry.js'));
  return module.processPersistenceTask(env, body, dependencies);
}

function logPersistenceResult(result) {
  logSampledSuccess({
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
  }, result?.observed_at, 60, 30);
}

function optimizedQueueStage(body) {
  if (body?.message_type !== 'stationhead-persistence-task' || body?.task !== 'queue') return null;
  return body.stage == null ? 'persist' : String(body.stage);
}

async function processPersistenceBatch(batch, env, dependencies = EMPTY_DEPENDENCIES) {
  const messages = batch.messages;
  if (!messages?.length) return;
  const message = messages[0];
  try {
    const stage = optimizedQueueStage(message.body);
    const result = stage === 'persist' || stage === 'structure-write'
      ? await processStructureTask(env, message.body, dependencies)
      : stage === 'likes'
        ? await processLikesPlanTask(env, message.body, dependencies)
        : stage === 'likes-write'
          ? await processLikesWriteTask(env, message.body, dependencies)
          : await processFallbackTask(env, message.body, dependencies);
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
