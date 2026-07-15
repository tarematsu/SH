import { jwtExpiryMs } from './shared.js';
import {
  asCollectorFailure,
} from './collector-failure.js';
import { collectOptionalComments } from './collector-comments.js';
import { buildCollectionPlan } from './collector-plan.js';
import { configFromEnv, shJson } from './collector-config.js';
import {
  attachMinuteFactQueueMetadata,
  extractIds,
  extractQueue,
  minuteFactQueue,
  minuteFactSnapshot,
  normalizeSnapshot,
  readModelPresentation,
  validateChannelPayload,
} from './collector-payload.js';
import { ingest } from './collector-ingest.js';
import { loadCollectorState, saveCollectorStateAndClearFailure } from './collector-state.js';
import { handoffMinuteFactJob } from './minute-facts-queue.js';

const SLOW_STAGE_THRESHOLD_MS = 1_000;
const RAW_D1_STATEMENT = Symbol('collector-raw-d1-statement');

export async function loadMinuteFactQueueMetadata(db, queue, providedRows = []) {
  let hydratedQueue = attachMinuteFactQueueMetadata(queue, providedRows);
  const spotifyIds = [...new Set(
    (hydratedQueue?.tracks || [])
      .filter((track) => track?.spotify_id
        && (!track.title || !track.artist || !track.thumbnail_url))
      .map((track) => String(track.spotify_id).trim())
      .filter(Boolean),
  )].slice(0, 80);
  if (!spotifyIds.length) return hydratedQueue;
  const placeholders = spotifyIds.map(() => '?').join(',');
  const result = await db.prepare(`SELECT spotify_id,title,artist,thumbnail_url
    FROM sh_track_metadata WHERE spotify_id IN (${placeholders})`)
    .bind(...spotifyIds).all();
  return attachMinuteFactQueueMetadata(hydratedQueue, result.results || []);
}

function signalFrom(value) {
  if (value && typeof value.aborted === 'boolean') return value;
  return value?.__COLLECTION_ABORT_SIGNAL || null;
}

function collectionAbortError(signal, stage) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(`Collection aborted during ${stage}`);
  error.name = 'AbortError';
  error.code = 'COLLECTION_ABORTED';
  return error;
}

export function throwIfCollectionAborted(value, stage = 'collection') {
  const signal = signalFrom(value);
  if (signal?.aborted) throw collectionAbortError(signal, stage);
}

function wrapD1Statement(statement, signal, stage) {
  return new Proxy(statement, {
    get(target, property) {
      if (property === RAW_D1_STATEMENT) return target;
      if (property === 'bind') {
        return (...args) => wrapD1Statement(target.bind(...args), signal, stage);
      }
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (!['first', 'run', 'all', 'raw'].includes(String(property))) return value.bind(target);
      return async (...args) => {
        throwIfCollectionAborted(signal, stage);
        const result = await value.apply(target, args);
        throwIfCollectionAborted(signal, stage);
        return result;
      };
    },
  });
}

export function withAbortableD1(db, signal, stage = 'd1') {
  if (!db || !signal) return db;
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => {
          throwIfCollectionAborted(signal, stage);
          return wrapD1Statement(target.prepare(sql), signal, stage);
        };
      }
      if (property === 'batch') {
        return async (statements) => {
          throwIfCollectionAborted(signal, stage);
          const result = await target.batch(
            (statements || []).map((statement) => statement?.[RAW_D1_STATEMENT] || statement),
          );
          throwIfCollectionAborted(signal, stage);
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function withCollectionSignal(env, signal) {
  const db = withAbortableD1(env?.DB, signal, 'stationhead-buddies');
  if (!signal && db === env?.DB) return env;

  const activeEnv = Object.create(env || null);
  Object.defineProperties(activeEnv, {
    __COLLECTION_ABORT_SIGNAL: {
      value: signal,
      enumerable: false,
    },
    DB: {
      value: db,
      enumerable: false,
    },
  });
  return activeEnv;
}

async function timedStage(
  stage,
  operation,
  thresholdMs = SLOW_STAGE_THRESHOLD_MS,
  timings = null,
) {
  const startedAt = Date.now();
  let outcome = 'success';
  try {
    return await operation();
  } catch (error) {
    outcome = 'error';
    throw error;
  } finally {
    const durationMs = Date.now() - startedAt;
    timings?.push({ stage, outcome, duration_ms: durationMs });
    if (outcome === 'error' || durationMs >= thresholdMs) {
      console.log(JSON.stringify({
        event: 'collector_stage_timing',
        stage,
        outcome,
        duration_ms: durationMs,
      }));
    }
  }
}

function logCollectionTiming(source, observedAt, startedAt, timings, outcome, stage = null) {
  console.log(JSON.stringify({
    event: 'collector_timing',
    source,
    observed_at: observedAt,
    outcome,
    total_ms: Date.now() - startedAt,
    ...(stage ? { failed_stage: stage } : {}),
    stages: timings,
  }));
}

function collectionTimingEnabled(env = {}) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(env.COLLECTOR_TIMING_ENABLED ?? '').trim().toLowerCase(),
  );
}

export async function collectOnce(env, source = 'manual') {
  const observedAt = Date.now();
  const startedAt = observedAt;
  const timings = collectionTimingEnabled(env) ? [] : null;
  const measure = (stage, operation) => timedStage(
    stage,
    operation,
    SLOW_STAGE_THRESHOLD_MS,
    timings,
  );
  let stage = 'collector_start';
  let state = null;
  const activeEnv = withCollectionSignal(env, signalFrom(env));

  try {
    if (!activeEnv.DB) throw new Error('DB binding is missing');
    const config = configFromEnv(activeEnv);
    throwIfCollectionAborted(activeEnv, stage);

    stage = activeEnv.__shAuthState ? 'sh_auth' : 'd1_read_collector_state';
    state = await measure(stage, () => loadCollectorState(activeEnv));
    const previousRunAt = Number(state.lastRunAt || 0);
    const metadataRetry = Boolean(state.lastError);
    state.lastRunAt = observedAt;
    state.lastError = null;

    stage = 'sh_channel_request';
    const channel = await measure(stage, () => shJson(
      state,
      config,
      `/channels/alias/${encodeURIComponent(config.channelAlias)}`,
    ));

    stage = 'sh_channel_payload';
    const { snapshot, queue, initialPlan } = await measure(stage, () => {
      validateChannelPayload(channel, config.channelAlias);
      extractIds(channel, state);

      const normalizedSnapshot = normalizeSnapshot(channel, state, config);
      const extractedQueue = extractQueue(channel, state.stationId);
      const planInput = {
        state,
        queue: extractedQueue,
        previousRunAt,
        observedAt,
        metadataRefreshIntervalMs: config.metadataRefreshIntervalMs,
        metadataRetry,
      };
      return {
        snapshot: normalizedSnapshot,
        queue: extractedQueue,
        initialPlan: buildCollectionPlan(planInput),
      };
    });

    if (initialPlan.snapshot) {
      stage = 'd1_write_snapshot';
      await measure(stage, () => ingest(
        activeEnv,
        'snapshot',
        snapshot,
        observedAt,
        { returnDetails: true },
      ));
    }

    let queueResult = null;
    let metadataPlanned = false;
    if (initialPlan.queue) {
      stage = 'd1_write_queue';
      queueResult = await measure(stage, () => ingest(activeEnv, 'queue', queue, observedAt));
      metadataPlanned = initialPlan.metadataDue || queueResult?.structure_changed === true;
    }

    let commentResult = {
      commentsSaved: 0,
      commentTotal: null,
      commentTotalKnown: false,
      degraded: false,
      errorStage: null,
    };
    if (initialPlan.comments) {
      stage = 'sh_chat_history';
      commentResult = await measure(stage, () => collectOptionalComments(
        activeEnv,
        state,
        config,
        observedAt,
      ));
    }

    const factSnapshot = minuteFactSnapshot(snapshot);
    const factQueue = minuteFactQueue(queue);
    const presentation = readModelPresentation(snapshot);
    const factQueueReadModel = {
      station_id: factQueue?.station_id ?? state.stationId,
      queue_id: factQueue?.queue_id ?? null,
      start_time: factQueue?.start_time ?? null,
      is_paused: factQueue?.is_paused ?? null,
    };
    if (factQueue === null) factQueueReadModel.value = null;
    stage = 'd1_outbox_minute_fact';
    const minuteFactJob = await measure(stage, () => handoffMinuteFactJob(activeEnv, {
      observedAt,
      snapshot: factSnapshot,
      queue: factQueue,
      comments: commentResult,
    }, {
      enrichTrackMetadata: metadataPlanned,
      collectComments: false,
      readModelPresentationOnly: true,
      readModel: {
        channel: {
          channel_id: state.channelId,
          observed_at: observedAt,
          presentation,
        },
        queue: factQueueReadModel,
        collector: {
          collector_id: config.collectorId,
          last_run_at: observedAt,
          last_success_at: observedAt,
          last_error_present: false,
          updated_at: observedAt,
        },
      },
    }));

    throwIfCollectionAborted(activeEnv, 'd1_write_collector_state');
    stage = 'd1_write_collector_state';
    await measure(stage, () => saveCollectorStateAndClearFailure(activeEnv, state, {
      lastRunAt: observedAt,
      lastSuccessAt: Date.now(),
      lastError: null,
      tokenExpiresAt: state.tokenExpiresAt || jwtExpiryMs(state.authToken),
    }));
    if (timings) logCollectionTiming(source, observedAt, startedAt, timings, 'ok');

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
      comments_deferred: false,
      queue_tracks: queue?.tracks?.length || 0,
      queue_inspected: Boolean(queueResult?.queue_inspected),
      queue_structure_changed: Boolean(queueResult?.structure_changed),
      queue_likes_changed: Boolean(queueResult?.likes_changed),
      queue_items_written: Number(queueResult?.queue_items_written || 0),
      like_observations_written: Number(queueResult?.like_observations_written || 0),
      metadata_saved: 0,
      metadata_deferred: Boolean(queue),
      metadata_delegated: Boolean(metadataPlanned),
      minute_fact_job_enqueued: Boolean(minuteFactJob?.enqueued),
      minute_fact_outbox_pending: Boolean(minuteFactJob?.outbox_pending),
      minute_fact_job_minute_at: minuteFactJob?.minute_at ?? null,
      heartbeat_written: false,
      token_expires_at: state.tokenExpiresAt || null,
    };
  } catch (error) {
    const failure = asCollectorFailure(error, stage, Date.now());
    if (state) {
      await saveCollectorState(activeEnv, state, {
        lastRunAt: observedAt,
        lastError: failure.message.slice(0, 2000),
        tokenExpiresAt: state.tokenExpiresAt || jwtExpiryMs(state.authToken),
      }).catch(() => {});
    }
    if (timings) logCollectionTiming(source, observedAt, startedAt, timings, 'error', stage);
    throw failure;
  }
}

export function runCollection(env, source = 'manual', collector = collectOnce) {
  return Promise.resolve().then(() => collector(env, source));
}
