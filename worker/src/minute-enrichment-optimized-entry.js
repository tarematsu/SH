import { processMinuteEnrichment } from './minute-enrichment-entry.js';

async function processMinuteEnrichmentBatch(batch, env) {
  const messages = batch.messages;
  if (!messages?.length) return;
  const message = messages[0];
  try {
    const result = await processMinuteEnrichment(env, message.body);
    console.log(JSON.stringify({ event: 'minute_enrichment_completed', ...result }));
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({
      event: 'minute_enrichment_failed',
      error: String(error?.message || error).slice(0, 800),
    }));
    message.retry({ delaySeconds: 30 });
  }
}

export default {
  queue: processMinuteEnrichmentBatch,
};
