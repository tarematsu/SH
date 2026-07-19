import { withAppleMusicFreeRuntime } from '../../site/functions/lib/apple-music-d1-pruner.js';
import { withMinuteD1WriteThrottling } from './minute-d1-write-throttle.js';
import {
  processMinuteDeriveMessage,
} from './minute-derive-router.js';

export const LIVE_DERIVE_QUEUE_NAME = 'stationhead-minute-live-derive';
export const REBUILD_DERIVE_QUEUE_NAME = 'stationhead-minute-derive';

const RETRY_60_SECONDS = Object.freeze({ delaySeconds: 60 });

function logMinuteDeriveResult(result, queueName = null) {
  console.log(JSON.stringify({
    event: result?.event || 'minute_derive_completed',
    processed: result?.processed ?? 0,
    failed: result?.failed ?? 0,
    pending: result?.pending === true,
    terminal: result?.terminal === true,
    job_id: result?.job_id ?? null,
    revision_id: result?.revision_id ?? null,
    derive_queue: queueName,
  }));
}

function activeDeriveEnv(batch, env) {
  const active = withMinuteD1WriteThrottling(withAppleMusicFreeRuntime(env));
  const sourceQueue = String(batch?.queue || '');
  const continuation = sourceQueue === LIVE_DERIVE_QUEUE_NAME
    ? env?.MINUTE_LIVE_DERIVE_QUEUE || env?.MINUTE_DERIVE_QUEUE
    : sourceQueue === REBUILD_DERIVE_QUEUE_NAME
      ? env?.MINUTE_DERIVE_QUEUE
      : env?.MINUTE_LIVE_DERIVE_QUEUE || env?.MINUTE_DERIVE_QUEUE;
  if (continuation) {
    Object.defineProperty(active, 'MINUTE_DERIVE_QUEUE', {
      value: continuation,
      enumerable: false,
      configurable: true,
    });
  }
  return active;
}

export async function processMinuteDeriveBatch(batch, env) {
  const messages = batch.messages;
  if (!messages?.length) return;
  const message = messages[0];
  const activeEnv = activeDeriveEnv(batch, env);

  try {
    const result = await processMinuteDeriveMessage(activeEnv, message.body);
    logMinuteDeriveResult(result, batch?.queue || null);
    if (result?.failed && !result.terminal && result.retry_message !== false) {
      const retryDelayMs = result.retry_delay_ms;
      const delaySeconds = typeof retryDelayMs === 'number' && Number.isFinite(retryDelayMs)
        ? Math.max(1, Math.ceil(retryDelayMs / 1000))
        : 60;
      message.retry(delaySeconds === 60 ? RETRY_60_SECONDS : { delaySeconds });
    } else {
      message.ack();
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: 'minute_derive_message_failed',
      derive_queue: batch?.queue || null,
      error: String(error?.message || error).slice(0, 800),
    }));
    if (error?.code === 'MINUTE_DERIVE_INVALID_TRIGGER') message.ack();
    else message.retry(RETRY_60_SECONDS);
  }
}

export default {
  queue: processMinuteDeriveBatch,
};
