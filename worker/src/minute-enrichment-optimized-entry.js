import { withAppleMusicFreeRuntime } from '../../site/functions/lib/apple-music-d1-pruner.js';
import { stripAppleMusicFields } from '../../site/functions/lib/api-utils.js';
import { withMinuteD1WriteThrottling } from './minute-d1-write-throttle.js';
import { processMinuteEnrichment } from './minute-enrichment-entry.js';
import {
  IDENTITY_BITE_STAGE,
  processMinuteIdentityBite,
  processMinuteIdentitySession,
} from './minute-enrichment-identity-stages.js';
import {
  PLAYBACK_PATCH_STAGE,
  processMinutePlaybackPatch,
  processMinutePlaybackResolve,
} from './minute-enrichment-playback-stages.js';
import { processTrackMetadataTask } from './track-metadata-entry.js';

export const TRACK_METADATA_QUEUE_NAME = 'stationhead-track-metadata';
const TRACK_METADATA_MESSAGE_TYPE = 'stationhead-track-metadata';
const RETRY_30_SECONDS = Object.freeze({ delaySeconds: 30 });
const EMPTY_DEPENDENCIES = Object.freeze({});
const SUCCESS_LOG_SAMPLE_MODULUS = 32;
const TRACK_METADATA_LOG_SAMPLE_MODULUS = 32;
const activeEnrichmentEnvs = new WeakMap();

function shouldLogMinuteEnrichmentResult(result) {
  if (result?.skipped === true || result?.reason) return true;
  const minuteAt = Number(result?.minuteAt);
  if (!Number.isFinite(minuteAt)) return false;
  return Math.abs(Math.floor(minuteAt / 60_000)) % SUCCESS_LOG_SAMPLE_MODULUS === 0;
}

function logMinuteEnrichmentResult(result) {
  if (!shouldLogMinuteEnrichmentResult(result)) return;
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
    bite_deferred: result?.bite_deferred === true,
    session_id: result?.session_id,
    host_id: result?.host_id,
    bite_count: result?.bite_count,
  }));
}

function stableSampleIdentity(value) {
  const text = String(value ?? '');
  const trailingNumber = text.match(/(\d+)(?!.*\d)/)?.[1];
  if (trailingNumber) return Number(trailingNumber);
  return text.length ? text.charCodeAt(text.length - 1) : 0;
}

function shouldLogTrackMetadataResult(result) {
  if (result?.reason || result?.skipped === true) return true;
  const identity = result?.job_id;
  if (identity == null || identity === '') return false;
  return stableSampleIdentity(identity) % TRACK_METADATA_LOG_SAMPLE_MODULUS === 0;
}

function sanitizeIdentityBody(body) {
  const tracks = body?.queue?.tracks;
  if (!Array.isArray(tracks) || tracks.length !== 1) return body;
  const track = tracks[0];
  if (!track || typeof track !== 'object' || !Object.hasOwn(track, 'apple_music_id')) return body;
  const { apple_music_id: _removedAppleMusicId, ...activeTrack } = track;
  return {
    ...body,
    queue: {
      ...body.queue,
      tracks: [activeTrack],
    },
  };
}

function activeEnrichmentBody(body) {
  return body?.stage === 'identity' || body?.stage === IDENTITY_BITE_STAGE
    ? sanitizeIdentityBody(body)
    : stripAppleMusicFields(body);
}

function productionEnrichmentEnv(env) {
  const cached = activeEnrichmentEnvs.get(env);
  if (cached) return cached;
  const active = withMinuteD1WriteThrottling(withAppleMusicFreeRuntime(env));
  activeEnrichmentEnvs.set(env, active);
  return active;
}

async function processOptimizedMinuteEnrichment(env, body, dependencies = EMPTY_DEPENDENCIES) {
  const activeBody = activeEnrichmentBody(body);
  if (activeBody?.stage === 'playback') {
    const run = dependencies.processMinutePlaybackResolve || processMinutePlaybackResolve;
    return run(env, activeBody, dependencies.playback || EMPTY_DEPENDENCIES);
  }
  if (activeBody?.stage === PLAYBACK_PATCH_STAGE) {
    const run = dependencies.processMinutePlaybackPatch || processMinutePlaybackPatch;
    return run(env, activeBody, dependencies.playback || EMPTY_DEPENDENCIES);
  }
  if (activeBody?.stage === IDENTITY_BITE_STAGE) {
    const run = dependencies.processMinuteIdentityBite || processMinuteIdentityBite;
    return run(env, activeBody, dependencies.identity || EMPTY_DEPENDENCIES);
  }
  if (activeBody?.stage === 'identity' && !dependencies.processMinuteEnrichment) {
    const run = dependencies.processMinuteIdentitySession || processMinuteIdentitySession;
    return run(env, activeBody, dependencies.identity || EMPTY_DEPENDENCIES);
  }
  const run = dependencies.processMinuteEnrichment || processMinuteEnrichment;
  return run(env, activeBody, dependencies.core || EMPTY_DEPENDENCIES);
}

function isTrackMetadataDelivery(batch, body) {
  return String(batch?.queue || '') === TRACK_METADATA_QUEUE_NAME
    || body?.message_type === TRACK_METADATA_MESSAGE_TYPE;
}

async function processMinuteEnrichmentBatch(batch, env, dependencies = EMPTY_DEPENDENCIES) {
  const messages = batch.messages;
  if (!messages?.length) return;
  const message = messages[0];
  const metadata = isTrackMetadataDelivery(batch, message.body);
  const activeEnv = metadata
    ? env
    : dependencies === EMPTY_DEPENDENCIES
      ? productionEnrichmentEnv(env)
      : env;
  try {
    if (metadata) {
      const run = dependencies.processTrackMetadataTask || processTrackMetadataTask;
      const result = await run(activeEnv, message.body, dependencies.metadata || EMPTY_DEPENDENCIES);
      if (shouldLogTrackMetadataResult(result)) {
        console.log(JSON.stringify({ event: 'track_metadata_task_completed', ...result }));
      }
    } else {
      const result = await processOptimizedMinuteEnrichment(activeEnv, message.body, dependencies);
      logMinuteEnrichmentResult(result);
    }
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({
      event: metadata ? 'track_metadata_task_failed' : 'minute_enrichment_failed',
      error: String(error?.message || error).slice(0, 800),
    }));
    message.retry(RETRY_30_SECONDS);
  }
}

export {
  activeEnrichmentBody,
  isTrackMetadataDelivery,
  processMinuteEnrichmentBatch,
  processOptimizedMinuteEnrichment,
  productionEnrichmentEnv,
  shouldLogMinuteEnrichmentResult,
  shouldLogTrackMetadataResult,
};

export default {
  queue: processMinuteEnrichmentBatch,
};
