import { withMinuteD1WriteThrottling } from './minute-d1-write-throttle.js';
import {
  processMinuteDeriveMessage,
} from './minute-derive-router.js';

const RETRY_60_SECONDS = Object.freeze({ delaySeconds: 60 });

function logMinuteDeriveResult(result) {
  console.log(JSON.stringify({
    event: result?.event || 'minute_derive_completed',
    processed: result?.processed ?? 0,
    failed: result?.failed ?? 0,
    pending: result?.pending === true,
    terminal: result?.terminal === true,
    job_id: result?.job_id ?? null,
    revision_id: result?.revision_id ?? null,
  }));
}

async function processMinuteDeriveBatch(batch, env) {
  const messages = batch.messages;
  if (!messages?.length) return;
  const message = messages[0];
  const activeEnv = withMinuteD1WriteThrottling(env);

  try {
    const result = await processMinuteDeriveMessage(activeEnv, message.body);
    logMinuteDeriveResult(result);
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
      error: String(error?.message || error).slice(0, 800),
    }));
    if (error?.code === 'MINUTE_DERIVE_INVALID_TRIGGER') message.ack();
    else message.retry(RETRY_60_SECONDS);
  }
}

export default {
  queue: processMinuteDeriveBatch,
};
