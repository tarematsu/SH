import { historicalRebuildEnabled } from './historical-rebuild-policy.js';
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
  return rebuild.processMinuteRebuildBatch(
    batch,
    rebuildEnvironment(env),
    ctx,
    dependencies,
  );
}

function acknowledgeDisabledHistoricalDerive(batch) {
  for (const message of batch?.messages || []) message.ack();
  console.log(JSON.stringify({
    event: 'minute_historical_derive_skipped',
    messages: batch?.messages?.length || 0,
    reason: 'historical-rebuild-disabled-for-d1-budget',
  }));
}

/**
 * Keep the minute Queue boundaries independent while sharing one deployment.
 * Each delegated handler remains the owner of ack/retry behavior for its queue.
 */
export async function processMinutePipelineBatch(batch, env, ctx, dependencies = EMPTY_DEPENDENCIES) {
  const queueName = String(batch?.queue || '');
  if (queueName === MINUTE_FACTS_QUEUE_NAME) {
    const consume = dependencies.consumeMinuteQueue || consumeMinuteQueue;
    return consume(batch, env, ctx);
  }
  if (queueName === REBUILD_DERIVE_QUEUE_NAME && !historicalRebuildEnabled(env)) {
    return acknowledgeDisabledHistoricalDerive(batch);
  }
  if (queueName === REBUILD_DERIVE_QUEUE_NAME || queueName === LIVE_DERIVE_QUEUE_NAME) {
    return processDeriveBatch(batch, env, dependencies.derive);
  }
  if (queueName === MINUTE_REBUILD_QUEUE_NAME) {
    return processRebuildBatch(batch, env, ctx, dependencies.rebuild);
  }
  throw new Error(`Unsupported minute pipeline queue: ${queueName || 'missing'}`);
}

export {
  acknowledgeDisabledHistoricalDerive,
};

export default {
  queue: processMinutePipelineBatch,
};
