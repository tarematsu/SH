import {
  processMinuteDeriveMessage,
} from './minute-derive-router.js';

export default {
  async queue(batch, env) {
    const messages = batch.messages;
    const messageCount = messages?.length || 0;
    for (let index = 0; index < messageCount; index += 1) {
      const message = messages[index];
      try {
        const result = await processMinuteDeriveMessage(env, message.body);
        console.log(JSON.stringify(result));
        if (result?.failed && !result?.terminal && result?.retry_message !== false) {
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
