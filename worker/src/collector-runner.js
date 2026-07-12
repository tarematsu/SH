import { jwtExpiryMs } from './shared.js';
import {
  asCollectorFailure,
  clearCollectorFailure,
  sanitizeFailureDetail,
} from './collector-failure.js';
import { buildCollectionPlan } from './collector-plan.js';
import { configFromEnv, shJson } from './collector-config.js';
import { collectOptionalComments } from './collector-comments.js';
import {
  extractIds,
  extractQueue,
  minuteFactQueue,
  minuteFactSnapshot,
  normalizeSnapshot,
  validateChannelPayload,
} from './collector-payload.js';
import { ingest } from './collector-ingest.js';
import { loadCollectorState, saveCollectorState } from './collector-state.js';
import { loadMinuteCommentFacts } from './minute-facts-source.js';
import { enqueueMinuteFactJob } from './minute-facts-inbox.js';
import { saveLiveMinuteFact } from './minute-facts-store.js';
import { combinedAbortSignal } from './request-signal.js';
import { enrichTracks as sharedEnrichTracks } from './shared.js';

const DEFAULT_MINUTE_FACT_TIMEOUT_MS = 12_000;
const MIN_MINUTE_FACT_TIMEOUT_MS = 1_000;
const MAX_MINUTE_FACT_TIMEOUT_MS = 20_000;
const SLOW_STAGE_THRESHOLD_MS = 1_000;
const RAW_D1_STATEMENT = Symbol('collector-raw-d1-statement');

async function enrichTracks(env, queue, observedAt, config) {
  return sharedEnrichTracks(env, ingest, queue, observedAt, config);
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
  const db = withAbortableD1(env?.DB, signal, 'stationhead-monitor');
  const factsDb = withAbortableD1(env?.FACTS_DB, signal, 'Stationhead-DB');
  return new Proxy(env || {}, {
    get(target, property, receiver) {
      if (property === '__COLLECTION_ABORT_SIGNAL') return signal;
      if (property === 'DB') return db;
      if (property === 'FACTS_DB') return factsDb;
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      return property === '__COLLECTION_ABORT_SIGNAL'
        || property === 'DB'
        || property === 'FACTS_DB'
        || Reflect.has(target, property);
    },
  });
}

function minuteFactTimeoutMs(env = {}) {
  const configured = Number(env.MINUTE_FACT_TIMEOUT_MS ?? DEFAULT_MINUTE_FACT_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_MINUTE_FACT_TIMEOUT_MS;
  return Math.max(MIN_MINUTE_FACT_TIMEOUT_MS, Math.min(MAX_MINUTE_FACT_TIMEOUT_MS, configured));
}

function rejectWhenAborted(signal, stage) {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(collectionAbortError(signal, stage));
      return;
    }
    signal.addEventListener('abort', () => reject(collectionAbortError(signal, stage)), { once: true });
  });
}

export async function saveLiveMinuteFactWithinBudget(env, input, writer = saveLiveMinuteFact) {
  const signal = combinedAbortSignal(signalFrom(env), minuteFactTimeoutMs(env));
  const boundedEnv = withCollectionSignal(env, signal);
  return Promise.race([
    Promise.resolve().then(() => writer(boundedEnv, input)),
    rejectWhenAborted(signal, 'd1_write_minute_fact'),
  ]);
}

async function timedStage(stage, operation, thresholdMs = SLOW_STAGE_THRESHOLD_MS) {
  const startedAt = Date.now();
  let outcome = 'success';
  try {
    return await operation();
  } catch (error) {
    outcome = 'error';
    throw error;
  } finally {
    const durationMs = Date.now() - startedAt;
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

export async function collectOnce(env, source = 'manual') {
  const observedAt = Date.now();
  let stage = 'collector_start';
  let state = null;
  const activeEnv = withCollectionSignal(env, signalFrom(env));

  try {
    if (!activeEnv.DB) throw new Error('DB binding is missing');
    const config = configFromEnv(activeEnv);
    throwIfCollectionAborted(activeEnv, stage);

    stage = activeEnv.__shAuthState ? 'sh_auth' : 'd1_read_collector_state';
    state = await timedStage(stage, () => loadCollectorState(activeEnv));
    const previousRunAt = Number(state.lastRunAt || 0);
    const metadataRetry = Boolean(state.lastError);
    state.lastRunAt = observedAt;
    state.lastError = null;

    stage = 'sh_channel_request';
    const channel = await timedStage(stage, () => shJson(
      state,
      config,
      `/channels/alias/${encodeURIComponent(config.channelAlias)}`,
    ));

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
      snapshotResult = await timedStage(stage, () => ingest(
        activeEnv,
        'snapshot',
        snapshot,
        observedAt,
        { returnDetails: true },
      ));
    }

    let queueResult = null;
    let metadataSaved = 0;
    let metadataPlanned = false;
    if (initialPlan.queue) {
      stage = 'd1_write_queue';
      queueResult = await timedStage(stage, () => ingest(activeEnv, 'queue', queue, observedAt));
      const completedPlan = buildCollectionPlan({ ...planInput, queueResult });
      metadataPlanned = completedPlan.metadata;
      if (metadataPlanned) {
        stage = 'd1_write_track_metadata';
        metadataSaved = await timedStage(stage, () => enrichTracks(activeEnv, queue, observedAt, config));
      }
    }

    stage = 'sh_chat_history';
    const commentResult = initialPlan.comments
      ? await timedStage(stage, () => collectOptionalComments(activeEnv, state, config, observedAt))
      : { commentsSaved: 0, degraded: false, errorStage: null };
    stage = 'd1_read_minute_comments';
    const minuteComments = await timedStage(
      stage,
      () => loadMinuteCommentFacts(activeEnv.DB, state.stationId, observedAt),
    );

    stage = 'd1_enqueue_minute_fact';
    const minuteFactJob = await timedStage(stage, () => enqueueMinuteFactJob(activeEnv, {
      observedAt,
      snapshot: minuteFactSnapshot(snapshot),
      queue: minuteFactQueue(queue),
      comments: { ...commentResult, ...minuteComments },
    }));

    throwIfCollectionAborted(activeEnv, 'd1_write_collector_state');
    stage = 'd1_write_collector_state';
    await timedStage(stage, () => saveCollectorState(activeEnv, state, {
      lastRunAt: observedAt,
      lastSuccessAt: Date.now(),
      lastError: null,
      tokenExpiresAt: jwtExpiryMs(state.authToken) || state.tokenExpiresAt,
    }));
    await clearCollectorFailure(activeEnv).catch((error) => {
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
      minute_fact_job_enqueued: Boolean(minuteFactJob?.enqueued),
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
        tokenExpiresAt: jwtExpiryMs(state.authToken) || state.tokenExpiresAt,
      }).catch(() => {});
    }
    throw failure;
  }
}

export function runCollection(env, source = 'manual', collector = collectOnce) {
  return Promise.resolve().then(() => collector(env, source));
}
