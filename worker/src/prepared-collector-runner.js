import { asCollectorFailure } from './collector-failure.js';
import { configFromEnv } from './collector-config.js';
import { ingest } from './collector-ingest.js';
import { buildCollectionPlan } from './collector-plan.js';
import {
  minuteFactQueue,
  minuteFactSnapshot,
  readModelPresentation,
} from './collector-payload.js';
import {
  collectorStateFromAuthState,
  saveCollectorState,
  saveCollectorStateAndClearFailure,
} from './collector-state.js';
import { handoffMinuteFactJob } from './minute-facts-queue.js';
import { jwtExpiryMs } from './shared.js';

const RAW_D1_STATEMENT = Symbol('prepared-collector-raw-d1-statement');
const PREPARED_COLLECTOR_FINALIZE = Symbol('prepared-collector-finalize');
const PREPARED_COLLECTOR_FACT = Symbol('prepared-collector-fact');
const NO_COMMENTS_RESULT = Object.freeze({
  commentsSaved: 0,
  degraded: false,
  errorStage: null,
});
const NO_PLANNED_COMMENTS_RESULT = Object.freeze({
  commentsSaved: 0,
  commentTotal: null,
  commentTotalKnown: false,
  degraded: false,
  errorStage: null,
});

export function preparedCollectorFinalizeState(result) {
  return result?.[PREPARED_COLLECTOR_FINALIZE] || null;
}

export function preparedCollectorFactStage(result) {
  return result?.[PREPARED_COLLECTOR_FACT] || null;
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

function throwIfAborted(value, stage) {
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
        throwIfAborted(signal, stage);
        const result = await value.apply(target, args);
        throwIfAborted(signal, stage);
        return result;
      };
    },
  });
}

function abortableDb(db, signal, stage = 'stationhead-buddies') {
  if (!db || !signal) return db;
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => {
          throwIfAborted(signal, stage);
          return wrapD1Statement(target.prepare(sql), signal, stage);
        };
      }
      if (property === 'batch') {
        return async (statements) => {
          throwIfAborted(signal, stage);
          const result = await target.batch(
            (statements || []).map((statement) => statement?.[RAW_D1_STATEMENT] || statement),
          );
          throwIfAborted(signal, stage);
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function activeEnvWithSignal(env) {
  const signal = signalFrom(env);
  if (!signal) return env;
  const active = Object.create(env || null);
  Object.defineProperties(active, {
    __COLLECTION_ABORT_SIGNAL: { value: signal, enumerable: false },
    DB: { value: abortableDb(env?.DB, signal), enumerable: false },
  });
  return active;
}

function preparedPayload(env, state, config, previousRunAt, observedAt, metadataRetry) {
  const prepared = env?.__shPreparedCollection;
  const snapshot = prepared?.snapshot;
  const queue = prepared?.queue ?? null;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('prepared collection snapshot is missing');
  }
  if (queue !== null && (typeof queue !== 'object' || Array.isArray(queue))) {
    throw new Error('prepared collection queue is invalid');
  }
  state.channelId = snapshot.channel_id;
  state.stationId = snapshot.station_id;
  return {
    snapshot,
    queue,
    plan: buildCollectionPlan({
      state,
      queue,
      previousRunAt,
      observedAt,
      metadataRefreshIntervalMs: config.metadataRefreshIntervalMs,
      metadataRetry,
    }),
  };
}

function finalizeState(state, observedAt, lastSuccessAt) {
  return {
    authToken: state.authToken,
    deviceUid: state.deviceUid,
    tokenExpiresAt: state.tokenExpiresAt || jwtExpiryMs(state.authToken) || null,
    lastRunAt: observedAt,
    lastSuccessAt,
    lastError: null,
    channelId: state.channelId,
    stationId: state.stationId,
    persistCredentials: state.persistCredentials !== false,
    clearFailureOnSuccess: state.clearFailureOnSuccess === true,
  };
}

function minuteAt(observedAt) {
  return Math.floor(Number(observedAt) / 60_000) * 60_000;
}

export async function collectPreparedOnce(env, source = 'raw-collection-queue') {
  const observedAt = Date.now();
  let stage = 'collector_start';
  let state = null;
  const activeEnv = activeEnvWithSignal(env);

  try {
    if (!activeEnv?.DB) throw new Error('DB binding is missing');
    if (!activeEnv.__shAuthState || !activeEnv.__shPreparedCollection) {
      throw new Error('prepared collector context is missing');
    }
    const config = configFromEnv(activeEnv);
    throwIfAborted(activeEnv, stage);

    stage = 'sh_auth';
    state = collectorStateFromAuthState(activeEnv.__shAuthState, activeEnv);
    const previousRunAt = Number(state.lastRunAt || 0);
    const metadataRetry = Boolean(state.lastError);
    state.lastRunAt = observedAt;
    state.lastError = null;

    stage = 'sh_channel_payload';
    const { snapshot, queue, plan } = preparedPayload(
      activeEnv,
      state,
      config,
      previousRunAt,
      observedAt,
      metadataRetry,
    );

    if (plan.snapshot) {
      stage = 'd1_write_snapshot';
      await ingest(activeEnv, 'snapshot', snapshot, observedAt, { returnDetails: true });
    }

    let queueResult = null;
    let metadataPlanned = false;
    if (plan.queue) {
      stage = 'd1_write_queue';
      queueResult = await ingest(activeEnv, 'queue', queue, observedAt, {
        metadataRequested: plan.metadataDue,
      });
      metadataPlanned = !activeEnv?.PERSIST_QUEUE?.send
        && (plan.metadataDue || queueResult?.structure_changed === true);
    }

    const commentResult = plan.comments
      ? NO_COMMENTS_RESULT
      : NO_PLANNED_COMMENTS_RESULT;
    const factSnapshot = minuteFactSnapshot(snapshot);
    const factQueue = minuteFactQueue(queue);
    const factQueueReadModel = {
      station_id: factQueue?.station_id ?? state.stationId,
      queue_id: factQueue?.queue_id ?? null,
      start_time: factQueue?.start_time ?? null,
      is_paused: factQueue?.is_paused ?? null,
    };
    if (factQueue === null) factQueueReadModel.value = null;
    const factOptions = {
      enrichTrackMetadata: metadataPlanned,
      collectComments: false,
      readModelPresentationOnly: true,
      readModel: {
        channel: {
          channel_id: state.channelId,
          observed_at: observedAt,
          presentation: readModelPresentation(snapshot),
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
    };
    const lastSuccessAt = Date.now();
    const deferredState = finalizeState(state, observedAt, lastSuccessAt);
    let minuteFactJob = null;
    let factStage = null;

    if (activeEnv?.INGEST_FINALIZE_QUEUE?.send) {
      factStage = {
        observedAt,
        snapshot: factSnapshot,
        queue: factQueue,
        comments: commentResult,
        options: factOptions,
        collectorState: deferredState,
        auth: activeEnv.__shAuthState || {},
      };
      minuteFactJob = {
        enqueued: false,
        outbox_pending: false,
        minute_at: minuteAt(observedAt),
      };
    } else {
      stage = 'd1_outbox_minute_fact';
      minuteFactJob = await handoffMinuteFactJob(activeEnv, {
        observedAt,
        snapshot: factSnapshot,
        queue: factQueue,
        comments: commentResult,
      }, factOptions);

      stage = 'd1_write_collector_state';
      throwIfAborted(activeEnv, stage);
      await saveCollectorStateAndClearFailure(activeEnv, state, {
        lastRunAt: observedAt,
        lastSuccessAt,
        lastError: null,
        tokenExpiresAt: deferredState.tokenExpiresAt,
      });
    }

    const summary = {
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
      minute_fact_stage_deferred: Boolean(factStage),
      heartbeat_written: false,
      token_expires_at: state.tokenExpiresAt || null,
      finalize_deferred: Boolean(factStage),
    };
    Object.defineProperty(summary, PREPARED_COLLECTOR_FINALIZE, { value: deferredState });
    if (factStage) Object.defineProperty(summary, PREPARED_COLLECTOR_FACT, { value: factStage });
    return summary;
  } catch (error) {
    const failure = asCollectorFailure(error, stage, Date.now());
    if (state) {
      await saveCollectorState(activeEnv, state, {
        lastRunAt: observedAt,
        lastError: failure.message.slice(0, 2000),
        tokenExpiresAt: state.tokenExpiresAt || jwtExpiryMs(state.authToken),
      }).catch(() => {});
    }
    throw failure;
  }
}
