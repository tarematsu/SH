import { processMinuteEnrichment } from './minute-enrichment-entry.js';

const RETRY_30_SECONDS = Object.freeze({ delaySeconds: 30 });

function logMinuteEnrichmentResult(result) {
  console.log(JSON.stringify({
    event: 'minute_enrichment_completed',
    skipped: result?.skipped === true,
    reason: result?.reason,
    pending: result?.pending === true,
    stage: result?.stage,
    channelId: result?.channelId,
    minuteAt: result?.minuteAt,
    observedAt: result?.observedAt,
    queue_position: result?.queue_position,
    track_id: result?.track_id,
    requested_materialized_tracks: result?.requested_materialized_tracks,
    session_id: result?.session_id,
    host_id: result?.host_id,
    bite_count: result?.bite_count,
  }));
}

async function processMinuteEnrichmentBatch(batch, env) {
  const messages = batch.messages;
  if (!messages?.length) return;
  const message = messages[0];
  try {
    const result = await processMinuteEnrichment(env, message.body);
    logMinuteEnrichmentResult(result);
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({
      event: 'minute_enrichment_failed',
      error: String(error?.message || error).slice(0, 800),
    }));
    message.retry(RETRY_30_SECONDS);
  }
}

export default {
  queue: processMinuteEnrichmentBatch,
};
