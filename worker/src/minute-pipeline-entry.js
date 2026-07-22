import { historicalRebuildEnabled } from './historical-rebuild-policy.js';
import {
  budgetedLiveCompleteMessage,
  processBudgetedLiveCompleteBatch,
} from './minute-live-complete-budget-entry.js';
import { processBudgetedLiveRevisionBatch } from './minute-live-revision-budget-entry.js';
import { processBudgetedLiveTriggerBatch } from './minute-live-trigger-budget-entry.js';
import { processBudgetedLiveWriteBatch } from './minute-live-write-budget-entry.js';
import { consumeMinuteQueue } from './minute-production-entry.js';

export const LIVE_DERIVE_QUEUE_NAME = 'stationhead-minute-live-derive';
export const REBUILD_DERIVE_QUEUE_NAME = 'stationhead-minute-derive';
export const MINUTE_FACTS_QUEUE_NAME = 'stationhead-buddies-facts';
export const MINUTE_REBUILD_QUEUE_NAME = 'stationhead-minute-rebuild';

const EMPTY_DEPENDENCIES = Object.freeze({});
let deriveModulePromise = null;
let rebuildModulePromise = null;

async function processDeriveBatch(batch, env, dependencies) {
  const derive = await (deriveModulePromise ||= import('./minute-derive-entry.js'));
  return derive.processMinuteDeriveBatch(batch, env, dependencies);
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.trunc(parsed) > 0 ? Math.trunc(parsed) : null;
}

function liveRevisionMaterializationEnabled(env = {}) {
  const value = env?.LIVE_REVISION_MATERIALIZATION_ENABLED;
  if (value == null || value === '') return historicalRebuildEnabled(env);
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function budgetedLiveTriggerBatch(batch, env) {
  if (liveRevisionMaterializationEnabled(env)) return false;
  const messages = batch?.messages || [];
  return messages.length > 0 && messages.every((message) => {
    const body = message?.body;
    return body?.message_type === 'minute-fact-derive'
      && Number(body?.message_version) === 1;
  });
}

function budgetedLiveRevisionBatch(batch, env) {
  if (liveRevisionMaterializationEnabled(env)) return false;
  const messages = batch?.messages || [];
  return messages.length > 0 && messages.every((message) => {
    const body = message?.body;
    return body?.message_type === 'minute-fact-derive-stage'
      && Number(body?.message_version) === 1
      && body?.stage === 'revision-materialize'
      && body?.revision?.sparse === true
      && body?.revision?.rebuild !== true;
  });
}

function budgetedLiveWriteBatch(batch, env) {
  if (liveRevisionMaterializationEnabled(env)) return false;
  const messages = batch?.messages || [];
  return messages.length > 0 && messages.every((message) => {
    const body = message?.body;
    return body?.message_type === 'minute-fact-derive-stage'
      && Number(body?.message_version) === 1
      && (body?.stage === 'write' || body?.stage === 'budget-live-write')
      && positiveInteger(body?.job?.id) != null
      && String(body?.job?.job_kind || 'live') !== 'rebuild'
      && body?.payload?.rebuild !== true;
  });
}

function budgetedLiveCompleteBatch(batch, env) {
  if (liveRevisionMaterializationEnabled(env)) return false;
  const messages = batch?.messages || [];
  return messages.length > 0
    && messages.every((message) => budgetedLiveCompleteMessage(message?.body));
}

function rebuildEnvironment(env) {
  if (env?.BUDDIES_DB || !env?.DB) return env;
  const active = Object.create(env);
  Object.defineProperty(active, 'BUDDIES_DB', {
    value: env.DB,
    enumerable: false,
    configurable: true,
  });
  return active;
}

async function processRebuildBatch(batch, env, ctx, dependencies) {
  const rebuild = await (rebuildModulePromise ||= import('./minute-rebuild-batched-entry.js'));
  return rebuild.processMinuteRebuildBatch(batch, rebuildEnvironment(env), ctx, dependencies);
}

function acknowledgeDisabledHistoricalDerive(batch) {
  for (const message of batch?.messages || []) message.ack();
  console.log(JSON.stringify({
    event: 'minute_historical_derive_skipped',
    messages: batch?.messages?.length || 0,
    reason: 'historical-rebuild-disabled-for-d1-budget',
  }));
}

export async function processMinutePipelineBatch(batch, env, ctx, dependencies = EMPTY_DEPENDENCIES) {
  const queueName = String(batch?.queue || '');
  if (queueName === MINUTE_FACTS_QUEUE_NAME) {
    const consume = dependencies.consumeMinuteQueue || consumeMinuteQueue;
    return consume(batch, env, ctx);
  }
  if (queueName === REBUILD_DERIVE_QUEUE_NAME && !historicalRebuildEnabled(env)) {
    return acknowledgeDisabledHistoricalDerive(batch);
  }
  if (queueName === LIVE_DERIVE_QUEUE_NAME && budgetedLiveTriggerBatch(batch, env)) {
    const run = dependencies.processBudgetedLiveTriggerBatch || processBudgetedLiveTriggerBatch;
    return run(batch, env, dependencies.liveTrigger);
  }
  if (queueName === LIVE_DERIVE_QUEUE_NAME && budgetedLiveRevisionBatch(batch, env)) {
    const run = dependencies.processBudgetedLiveRevisionBatch || processBudgetedLiveRevisionBatch;
    return run(batch, env, dependencies.liveRevision);
  }
  if (queueName === LIVE_DERIVE_QUEUE_NAME && budgetedLiveWriteBatch(batch, env)) {
    const run = dependencies.processBudgetedLiveWriteBatch || processBudgetedLiveWriteBatch;
    return run(batch, env, dependencies.liveWrite);
  }
  if (queueName === LIVE_DERIVE_QUEUE_NAME && budgetedLiveCompleteBatch(batch, env)) {
    const run = dependencies.processBudgetedLiveCompleteBatch || processBudgetedLiveCompleteBatch;
    return run(batch, env, dependencies.liveComplete);
  }
  if (queueName === REBUILD_DERIVE_QUEUE_NAME || queueName === LIVE_DERIVE_QUEUE_NAME) {
    const run = dependencies.processMinuteDeriveBatch;
    if (run) return run(batch, env, dependencies.derive);
    return processDeriveBatch(batch, env, dependencies.derive);
  }
  if (queueName === MINUTE_REBUILD_QUEUE_NAME) {
    return processRebuildBatch(batch, env, ctx, dependencies.rebuild);
  }
  throw new Error(`Unsupported minute pipeline queue: ${queueName || 'missing'}`);
}

export {
  acknowledgeDisabledHistoricalDerive,
  budgetedLiveCompleteBatch,
  budgetedLiveTriggerBatch,
  budgetedLiveRevisionBatch,
  budgetedLiveWriteBatch,
};

export default {
  queue: processMinutePipelineBatch,
};
