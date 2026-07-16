import {
  processMinuteDeriveTrigger,
} from './minute-derive-queue.js';

async function recordDeriveRuntime(env, outcome, startedAt) {
  if (!env?.MINUTE_DB) return;
  const { recordMinuteFactRuntimeState } = await import('./minute-facts-runtime-state.js');
  await recordMinuteFactRuntimeState(env, 'derive', outcome, {
    startedAt,
    success: !outcome?.failed,
  });
}

export default {
  async queue(batch, env, ctx) {
    for (const message of batch.messages || []) {
      const startedAt = Date.now();
      try {
        const result = await processMinuteDeriveTrigger(env, message.body);
        console.log(JSON.stringify(result));
        const record = recordDeriveRuntime(env, result, startedAt).catch((error) => {
          console.warn(JSON.stringify({
            event: 'minute_derive_runtime_state_failed',
            error: String(error?.message || error).slice(0, 800),
          }));
        });
        if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(record);
        else void record;

        if (result?.failed && !result?.terminal) {
          message.retry({
            delaySeconds: Math.max(1, Math.ceil(Number(result.retry_delay_ms || 60_000) / 1000)),
          });
        } else {
          message.ack();
        }
      } catch (error) {
        console.error(JSON.stringify({
          event: 'minute_derive_message_failed',
          error: String(error?.message || error).slice(0, 800),
        }));
        if (error?.code === 'MINUTE_DERIVE_INVALID_TRIGGER') message.ack();
        else message.retry({ delaySeconds: 60 });
      }
    }
  },
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
