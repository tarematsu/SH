import {
  runTrackHistoryCycleStep as runLegacyTrackHistoryCycleStep,
  TRACK_HISTORY_ACTIVE_MINUTES,
  TRACK_HISTORY_CYCLE_MS,
  TRACK_HISTORY_STAGE_KEY,
} from './pages-track-history-cycle.js';
import { initializeTrackHistoryPublication } from './pages-track-history-publication.js';
import {
  enqueueTrackHistoryPublication,
  trackHistoryPublicationStalled,
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

async function dispatchPublication(env, stage, timestamp, dependencies = {}, reason = 'start') {
  const enqueue = dependencies.enqueuePublication || enqueueTrackHistoryPublication;
  await enqueue(env, stage.publication.generation, dependencies);
  return {
    ...responseBase(timestamp, stage),
    task: {
      kind: 'track-history-publish-dispatch',
      key: 'track-history',
      generation: stage.publication.generation,
    },
    publication: {
      action: reason,
      phase: stage.publication.phase,
      rows_written: stage.publication.rows_written,
      chunks: stage.publication.next_chunk_index,
    },
  };
}

async function initializePublication(env, stage, timestamp, dependencies = {}) {
  const status = await finalizeTrackHistoryStatus(env, stage, timestamp, dependencies);
  const create = dependencies.createPublication || createTrackHistoryPublication;
  const initialize = dependencies.initializePublication || initializeTrackHistoryPublication;
  const publication = create(stage, status, timestamp, env);
  stage.publication = await initialize(env.MINUTE_DB, publication, dependencies);
  stage.updated_at = timestamp;
  const save = dependencies.saveStage || saveTrackHistoryStage;
  await save(env.MINUTE_DB, stage, timestamp);
  if (hasPublicationQueue(env, dependencies)) {
    return dispatchPublication(env, stage, timestamp, dependencies, 'initialized');
  }
  const { processTrackHistoryPublicationTask } = await import('./pages-track-history-publication-queue.js');
  return processTrackHistoryPublicationTask(env, {
    message_type: 'stationhead-pages-track-history-publication',
    message_version: 1,
    generation: stage.publication.generation,
  }, dependencies);
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
  if (stage.published && !stage.publication) {
    stage.published = false;
    stage.published_at = null;
    return initializePublication(env, stage, timestamp, dependencies);
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
  if (!stage.publication) return initializePublication(env, stage, timestamp, dependencies);
  if (hasPublicationQueue(env, dependencies)) {
    if (trackHistoryPublicationStalled(stage, timestamp)) {
      return dispatchPublication(env, stage, timestamp, dependencies, 'stalled-requeue');
    }
    return {
      skipped: true,
      reason: 'track-history-publication-queue-active',
      generated_at: timestamp,
      task: {
        kind: 'track-history-publish-wait',
        key: 'track-history',
        generation: stage.publication.generation,
      },
      responses: [],
      failed: 0,
    };
  }
  const { processTrackHistoryPublicationTask } = await import('./pages-track-history-publication-queue.js');
  return processTrackHistoryPublicationTask(env, {
    message_type: 'stationhead-pages-track-history-publication',
    message_version: 1,
    generation: stage.publication.generation,
  }, dependencies);
}
