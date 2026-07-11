import { jwtExpiryMs } from './shared.js';
import {
  asCollectorFailure,
  clearCollectorFailure,
  sanitizeFailureDetail,
} from './collector-failure.js';
import { buildCollectionPlan } from './collector-plan.js';
import { configFromEnv, shJson } from './collector-config.js';
import { collectOptionalComments } from './collector-comments.js';
import { extractIds, extractQueue, normalizeSnapshot, validateChannelPayload } from './collector-payload.js';
import { ingest } from './collector-ingest.js';
import { loadCollectorState, saveCollectorState } from './collector-state.js';
import { loadMinuteCommentFacts } from './minute-facts-source.js';
import { saveLiveMinuteFact } from './minute-facts-store.js';
import { enrichTracks as sharedEnrichTracks } from './shared.js';

let collectionFlight = null;

async function enrichTracks(env, queue, observedAt, config) {
  return sharedEnrichTracks(env, ingest, queue, observedAt, config);
}

export async function collectOnce(env, source = 'manual') {
  const observedAt = Date.now();
  let stage = 'collector_start';
  let state = null;

  try {
    if (!env.DB) throw new Error('DB binding is missing');
    const config = configFromEnv(env);

    stage = env.__shAuthState ? 'sh_auth' : 'd1_read_collector_state';
    state = await loadCollectorState(env);
    const previousRunAt = Number(state.lastRunAt || 0);
    const metadataRetry = Boolean(state.lastError);
    state.lastRunAt = observedAt;
    state.lastError = null;

    stage = 'sh_channel_request';
    const channel = await shJson(state, config, `/channels/alias/${encodeURIComponent(config.channelAlias)}`);

    stage = 'sh_channel_payload';
    validateChannelPayload(channel, config.channelAlias);
    extractIds(channel, state);

    const snapshot = normalizeSnapshot(channel, state, config);
    const queue = extractQueue(channel, state.stationId);
    const planInput = {
      state,
      queue,
      previousRunAt,
      observedAt,
      metadataRefreshIntervalMs: config.metadataRefreshIntervalMs,
      metadataRetry,
    };
    const initialPlan = buildCollectionPlan(planInput);

    let snapshotResult = null;
    if (initialPlan.snapshot) {
      stage = 'd1_write_snapshot';
      snapshotResult = await ingest(env, 'snapshot', snapshot, observedAt, { returnDetails: true });
    }

    let queueResult = null;
    let metadataSaved = 0;
    let metadataPlanned = false;
    if (initialPlan.queue) {
      stage = 'd1_write_queue';
      queueResult = await ingest(env, 'queue', queue, observedAt);
      const completedPlan = buildCollectionPlan({ ...planInput, queueResult });
      metadataPlanned = completedPlan.metadata;
      if (metadataPlanned) {
        stage = 'd1_write_track_metadata';
        metadataSaved = await enrichTracks(env, queue, observedAt, config);
      }
    }

    const commentResult = initialPlan.comments
      ? await collectOptionalComments(env, state, config, observedAt)
      : { commentsSaved: 0, degraded: false, errorStage: null };
    const minuteComments = await loadMinuteCommentFacts(env.DB, state.stationId, observedAt);

    try {
      stage = 'd1_write_minute_fact';
      await saveLiveMinuteFact(env, {
        observedAt,
        snapshot,
        snapshotResult,
        queue,
        queueResult,
        comments: { ...commentResult, ...minuteComments },
      });
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'minute_fact_write_failed',
        error: sanitizeFailureDetail(error?.message || error),
      }));
    }

    stage = 'd1_write_collector_state';
    await saveCollectorState(env, state, {
      lastRunAt: observedAt,
      lastSuccessAt: Date.now(),
      lastError: null,
      tokenExpiresAt: jwtExpiryMs(state.authToken) || state.tokenExpiresAt,
    });
    await clearCollectorFailure(env).catch((error) => {
      console.warn(JSON.stringify({
        event: 'collector_failure_clear_failed',
        error: sanitizeFailureDetail(error?.message || error),
      }));
    });

    return {
      ok: true,
      source,
      observed_at: observedAt,
      channel_alias: config.channelAlias,
      channel_id: state.channelId,
      station_id: state.stationId,
      comments_saved: commentResult.commentsSaved,
      comments_degraded: commentResult.degraded,
      comments_error_stage: commentResult.errorStage,
      queue_tracks: queue?.tracks?.length || 0,
      queue_inspected: Boolean(queueResult?.queue_inspected),
      queue_structure_changed: Boolean(queueResult?.structure_changed),
      queue_likes_changed: Boolean(queueResult?.likes_changed),
      queue_items_written: Number(queueResult?.queue_items_written || 0),
      like_observations_written: Number(queueResult?.like_observations_written || 0),
      metadata_saved: metadataSaved,
      metadata_deferred: Boolean(queue && !metadataPlanned),
      heartbeat_written: false,
      token_expires_at: state.tokenExpiresAt || null,
    };
  } catch (error) {
    const failure = asCollectorFailure(error, stage, Date.now());
    if (state) {
      await saveCollectorState(env, state, {
        lastRunAt: observedAt,
        lastError: failure.message.slice(0, 2000),
        tokenExpiresAt: jwtExpiryMs(state.authToken) || state.tokenExpiresAt,
      }).catch(() => {});
    }
    throw failure;
  }
}

export function runCollection(env, source = 'manual', collector = collectOnce) {
  if (collectionFlight) return collectionFlight;
  collectionFlight = Promise.resolve()
    .then(() => collector(env, source))
    .finally(() => { collectionFlight = null; });
  return collectionFlight;
}

export function resetCollectionFlight() {
  collectionFlight = null;
}
