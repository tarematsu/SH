import { withAppleMusicFreeD1 } from '../../site/functions/lib/apple-music-d1-pruner.js';
import { stripAppleMusicFields } from '../../site/functions/lib/api-utils.js';
import { withMinuteD1WriteThrottling } from './minute-d1-write-throttle.js';
import { processMinuteEnrichment } from './minute-enrichment-entry.js';
import {
  PLAYBACK_PATCH_STAGE,
  processMinutePlaybackPatch,
  processMinutePlaybackResolve,
} from './minute-enrichment-playback-stages.js';

const RETRY_30_SECONDS = Object.freeze({ delaySeconds: 30 });
const EMPTY_DEPENDENCIES = Object.freeze({});

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
    playback_patch_deferred: result?.playback_patch_deferred === true,
    session_id: result?.session_id,
    host_id: result?.host_id,
    bite_count: result?.bite_count,
  }));
}

async function processOptimizedMinuteEnrichment(env, body, dependencies = EMPTY_DEPENDENCIES) {
  const activeBody = stripAppleMusicFields(body);
  if (activeBody?.stage === 'playback') {
    const run = dependencies.processMinutePlaybackResolve || processMinutePlaybackResolve;
    return run(env, activeBody, dependencies.playback || EMPTY_DEPENDENCIES);
  }
  if (activeBody?.stage === PLAYBACK_PATCH_STAGE) {
    const run = dependencies.processMinutePlaybackPatch || processMinutePlaybackPatch;
    return run(env, activeBody, dependencies.playback || EMPTY_DEPENDENCIES);
  }
  const run = dependencies.processMinuteEnrichment || processMinuteEnrichment;
  return run(env, activeBody, dependencies.core || EMPTY_DEPENDENCIES);
}

async function processMinuteEnrichmentBatch(batch, env, dependencies = EMPTY_DEPENDENCIES) {
  const messages = batch.messages;
  if (!messages?.length) return;
  const message = messages[0];
  const activeEnv = dependencies === EMPTY_DEPENDENCIES
    ? withMinuteD1WriteThrottling(withAppleMusicFreeD1(env))
    : env;
  try {
    const result = await processOptimizedMinuteEnrichment(activeEnv, message.body, dependencies);
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

export { processMinuteEnrichmentBatch, processOptimizedMinuteEnrichment };

export default {
  queue: processMinuteEnrichmentBatch,
};
