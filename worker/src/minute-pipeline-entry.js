import { consumeMinuteQueue } from './minute-production-entry.js';

export const LIVE_DERIVE_QUEUE_NAME = 'stationhead-minute-live-derive';
export const REBUILD_DERIVE_QUEUE_NAME = 'stationhead-minute-derive';
export const MINUTE_FACTS_QUEUE_NAME = 'stationhead-buddies-facts';

const EMPTY_DEPENDENCIES = Object.freeze({});
let deriveModulePromise = null;

async function processDeriveBatch(batch, env, dependencies) {
  const derive = await (deriveModulePromise ||= import('./minute-derive-entry.js'));
  return derive.processMinuteDeriveBatch(batch, env, dependencies);
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
  if (queueName === REBUILD_DERIVE_QUEUE_NAME || queueName === LIVE_DERIVE_QUEUE_NAME) {
    return processDeriveBatch(batch, env, dependencies.derive);
  }
  throw new Error(`Unsupported minute pipeline queue: ${queueName || 'missing'}`);
}

export default {
  queue: processMinutePipelineBatch,
};
