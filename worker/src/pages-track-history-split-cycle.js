import {
  runTrackHistoryCycleStep as runLegacyTrackHistoryCycleStep,
  TRACK_HISTORY_ACTIVE_MINUTES,
  TRACK_HISTORY_CYCLE_MS,
  TRACK_HISTORY_STAGE_KEY,
} from './pages-track-history-cycle.js';
import { initializeTrackHistoryPublication } from './pages-track-history-publication.js';
import {
  enqueueTrackHistoryPublication,
  TRACK_HISTORY_PUBLICATION_ACTIONS,
  trackHistoryPublicationRecoveryAction,
} from './pages-track-history-publication-queue.js';
import { createTrackHistoryPublication } from './pages-track-history-response.js';
import {
  finalizeTrackHistoryStatus,
  loadTrackHistoryStage,
  runLateTrackHistoryShard,
  saveTrackHistoryStage,
} from './pages-track-history-stage.js';

function responseBase(timestamp, stage) {
  return {
    skipped: false,
    generated_at: timestamp,
    stage: {
      refresh_mode: stage.refresh_mode,
      shards: stage.tasks.length,
      published: stage.published === true,
    },
    responses: [],
    succeeded: 0,
    failed: 0,
  };
}

function hasPublicationQueue(env, dependencies) {
  return Boolean(dependencies.sendPublication || env?.PAGES_READ_MODEL_QUEUE?.send);
}

function actionGeneration(stage, action) {
  return action === TRACK_HISTORY_PUBLICATION_ACTIONS.PAGE
    ? stage.publication?.generation
    : stage.generation;
}

async function dispatchPublication(env, stage, timestamp, action, dependencies = {}, reason = action) {
  const generation = actionGeneration(stage, action);
  if (!generation) throw new Error(`track-history publication ${action} generation is missing`);
  const enqueue = dependencies.enqueuePublication || enqueueTrackHistoryPublication;
  await enqueue(env, generation, dependencies, action);
  return {
    ...responseBase(timestamp, stage),
    task: {
      kind: 'track-history-publish-dispatch',
      key: 'track-history',
      generation,
    },
    publication: {
      action: reason,
      phase: stage.publication?.phase || (stage.publication_status ? 'status-ready' : 'initializing'),
      rows_written: Number(stage.publication?.rows_written || 0),
      chunks: Number(stage.publication?.next_chunk_index || 0),
    },
  };
}

async function beginPublicationInitialization(env, stage, timestamp, dependencies = {}, reason = 'start') {
  stage.published = false;
  stage.published_at = null;
  stage.publication_initializing_at = timestamp;
  stage.updated_at = timestamp;
  const save = dependencies.saveStage || saveTrackHistoryStage;
  await save(env.MINUTE_DB, stage, timestamp);
  return dispatchPublication(
    env,
    stage,
    timestamp,
    TRACK_HISTORY_PUBLICATION_ACTIONS.STATUS,
    dependencies,
    reason,
  );
}

async function initializePublicationInline(env, stage, timestamp, dependencies = {}) {
  const status = await finalizeTrackHistoryStatus(env, stage, timestamp, dependencies);
  const create = dependencies.createPublication || createTrackHistoryPublication;
  const initialize = dependencies.initializePublication || initializeTrackHistoryPublication;
  const publication = create(stage, status, timestamp, env);
  stage.publication = await initialize(env.MINUTE_DB, publication, dependencies);
  stage.updated_at = timestamp;
  const save = dependencies.saveStage || saveTrackHistoryStage;
  await save(env.MINUTE_DB, stage, timestamp);
  const { processTrackHistoryPublicationTask } = await import('./pages-track-history-publication-queue.js');
  return processTrackHistoryPublicationTask(env, {
    message_type: 'stationhead-pages-track-history-publication',
    message_version: 1,
    generation: stage.publication.generation,
  }, dependencies);
}

function waitResult(timestamp, stage, reason) {
  return {
    skipped: true,
    reason,
    generated_at: timestamp,
    task: {
      kind: 'track-history-publish-wait',
      key: 'track-history',
      generation: stage.publication?.generation || stage.generation,
    },
    responses: [],
    failed: 0,
  };
}

export async function runSplitTrackHistoryCycleStep(env, now = Date.now(), dependencies = {}) {
  const timestamp = Number(now);
  if (!env?.BUDDIES_DB || !env?.MINUTE_DB) {
    throw new Error('track-history cycle step is missing BUDDIES_DB or MINUTE_DB');
  }
  const load = dependencies.loadStage || loadTrackHistoryStage;
  const stage = await load(env.MINUTE_DB);
  const currentGeneration = Math.floor(timestamp / TRACK_HISTORY_CYCLE_MS) * TRACK_HISTORY_CYCLE_MS;
  if (!stage || (stage.published && Number(stage.generation) !== currentGeneration)) {
    return runLegacyTrackHistoryCycleStep(env, timestamp, dependencies);
  }
  const queued = hasPublicationQueue(env, dependencies);
  if (stage.published && !stage.publication) {
    return queued
      ? beginPublicationInitialization(env, stage, timestamp, dependencies, 'legacy-stage-migration')
      : initializePublicationInline(env, stage, timestamp, dependencies);
  }
  if (stage.published) {
    return {
      skipped: true,
      reason: 'track-history-cycle-already-published',
      generated_at: timestamp,
      task: { kind: 'track-history-idle', key: TRACK_HISTORY_STAGE_KEY, generation: stage.generation },
      responses: [],
      failed: 0,
    };
  }

  const nextTask = stage.tasks.find((task) => !stage.completed?.[task.id]);
  if (nextTask) {
    const cycleStart = Math.floor(timestamp / TRACK_HISTORY_CYCLE_MS) * TRACK_HISTORY_CYCLE_MS;
    const cycleMinute = Math.floor((timestamp - cycleStart) / 60_000);
    if (cycleMinute < TRACK_HISTORY_ACTIVE_MINUTES) {
      return runLegacyTrackHistoryCycleStep(env, timestamp, dependencies);
    }
    return runLateTrackHistoryShard(env, stage, timestamp, dependencies);
  }
  if (!queued) {
    return stage.publication
      ? initializePublicationInline(env, stage, timestamp, dependencies)
      : initializePublicationInline(env, stage, timestamp, dependencies);
  }

  if (!stage.publication && !stage.publication_status && !stage.publication_initializing_at) {
    return beginPublicationInitialization(env, stage, timestamp, dependencies, 'initialized');
  }
  const recoveryAction = trackHistoryPublicationRecoveryAction(stage, timestamp);
  if (recoveryAction) {
    if (recoveryAction === TRACK_HISTORY_PUBLICATION_ACTIONS.STATUS) {
      stage.publication_initializing_at = timestamp;
      stage.updated_at = timestamp;
      const save = dependencies.saveStage || saveTrackHistoryStage;
      await save(env.MINUTE_DB, stage, timestamp);
    }
    return dispatchPublication(
      env,
      stage,
      timestamp,
      recoveryAction,
      dependencies,
      `stalled-${recoveryAction}-requeue`,
    );
  }
  return waitResult(timestamp, stage, 'track-history-publication-queue-active');
}
