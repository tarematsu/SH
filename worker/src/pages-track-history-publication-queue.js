import {
  advanceTrackHistoryPublication,
  initializeTrackHistoryPublication,
} from './pages-track-history-publication.js';
import { createTrackHistoryPublication } from './pages-track-history-response.js';
import {
  finalizeTrackHistoryStatus,
  loadTrackHistoryStage,
  saveTrackHistoryStage,
} from './pages-track-history-stage.js';

export const TRACK_HISTORY_PUBLICATION_MESSAGE = 'stationhead-pages-track-history-publication';
export const TRACK_HISTORY_PUBLICATION_STALE_MS = 2 * 60_000;
export const TRACK_HISTORY_PUBLICATION_ACTIONS = Object.freeze({
  STATUS: 'status',
  INITIALIZE: 'initialize',
  PAGE: 'page',
});

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function taskBody(action, generation) {
  return {
    message_type: TRACK_HISTORY_PUBLICATION_MESSAGE,
    message_version: 2,
    action,
    generation: String(generation || ''),
  };
}

export async function enqueueTrackHistoryPublication(
  env,
  generation,
  dependencies = {},
  action = TRACK_HISTORY_PUBLICATION_ACTIONS.PAGE,
) {
  const send = dependencies.sendPublication
    || ((body) => env?.PAGES_READ_MODEL_QUEUE?.send(body, { contentType: 'json' }));
  if (!dependencies.sendPublication && !env?.PAGES_READ_MODEL_QUEUE?.send) {
    throw new Error('PAGES_READ_MODEL_QUEUE binding is missing');
  }
  await send(taskBody(action, generation));
}

function stale(updatedAt, now) {
  const timestamp = integer(updatedAt);
  return timestamp == null || Number(now) - timestamp >= TRACK_HISTORY_PUBLICATION_STALE_MS;
}

export function trackHistoryPublicationRecoveryAction(stage, now = Date.now()) {
  if (!stage || stage.published === true) return null;
  if (stage.publication) {
    return stale(stage.publication.updated_at ?? stage.updated_at, now)
      ? TRACK_HISTORY_PUBLICATION_ACTIONS.PAGE
      : null;
  }
  if (stage.publication_status) {
    return stale(stage.publication_status_updated_at ?? stage.updated_at, now)
      ? TRACK_HISTORY_PUBLICATION_ACTIONS.INITIALIZE
      : null;
  }
  return stale(stage.publication_initializing_at ?? stage.updated_at, now)
    ? TRACK_HISTORY_PUBLICATION_ACTIONS.STATUS
    : null;
}

function validateTask(body) {
  if (body?.message_type !== TRACK_HISTORY_PUBLICATION_MESSAGE
      || !String(body?.generation || '').trim()) {
    throw new Error('invalid track-history publication task');
  }
  const version = integer(body.message_version);
  if (version === 1) {
    return { action: TRACK_HISTORY_PUBLICATION_ACTIONS.PAGE, generation: String(body.generation) };
  }
  const action = String(body.action || '');
  if (version !== 2 || !Object.values(TRACK_HISTORY_PUBLICATION_ACTIONS).includes(action)) {
    throw new Error('invalid track-history publication task');
  }
  return { action, generation: String(body.generation) };
}

function stageGenerationMatches(stage, generation) {
  return String(stage?.generation ?? '') === generation;
}

async function processStatusStage(env, stage, generation, timestamp, dependencies) {
  if (!stageGenerationMatches(stage, generation)) {
    return { skipped: true, reason: 'track-history-publication-generation-stale', generation };
  }
  if (stage.published === true && stage.publication) {
    return { skipped: true, reason: 'track-history-publication-already-published', generation };
  }
  const finalize = dependencies.finalizeStatus || finalizeTrackHistoryStatus;
  const status = await finalize(env, stage, timestamp, dependencies);
  stage.publication_status = status;
  stage.publication_status_updated_at = timestamp;
  stage.publication_initializing_at = timestamp;
  stage.updated_at = timestamp;
  const save = dependencies.saveStage || saveTrackHistoryStage;
  await save(env.MINUTE_DB, stage, timestamp);
  await enqueueTrackHistoryPublication(
    env,
    generation,
    dependencies,
    TRACK_HISTORY_PUBLICATION_ACTIONS.INITIALIZE,
  );
  return {
    skipped: false,
    event: 'track_history_publication_step_completed',
    generation,
    action: TRACK_HISTORY_PUBLICATION_ACTIONS.STATUS,
    phase: 'status-ready',
    rows: 0,
    rows_written: 0,
    chunks: 0,
    published: false,
  };
}

async function processInitializeStage(env, stage, generation, timestamp, dependencies) {
  if (!stageGenerationMatches(stage, generation)) {
    return { skipped: true, reason: 'track-history-publication-generation-stale', generation };
  }
  if (stage.publication) {
    if (stage.published === true || stage.publication.phase === 'published') {
      return { skipped: true, reason: 'track-history-publication-already-published', generation };
    }
    await enqueueTrackHistoryPublication(
      env,
      stage.publication.generation,
      dependencies,
      TRACK_HISTORY_PUBLICATION_ACTIONS.PAGE,
    );
    return {
      skipped: false,
      event: 'track_history_publication_step_completed',
      generation: stage.publication.generation,
      action: 'initialize-reused',
      phase: stage.publication.phase,
      rows: 0,
      rows_written: Number(stage.publication.rows_written || 0),
      chunks: 0,
      published: false,
    };
  }
  if (!stage.publication_status) {
    throw new Error('track-history publication status checkpoint is missing');
  }
  const create = dependencies.createPublication || createTrackHistoryPublication;
  const initialize = dependencies.initializePublication || initializeTrackHistoryPublication;
  const publication = create(stage, stage.publication_status, timestamp, env);
  stage.publication = await initialize(env.MINUTE_DB, publication, dependencies);
  delete stage.publication_status;
  delete stage.publication_status_updated_at;
  delete stage.publication_initializing_at;
  stage.updated_at = timestamp;
  const save = dependencies.saveStage || saveTrackHistoryStage;
  await save(env.MINUTE_DB, stage, timestamp);
  await enqueueTrackHistoryPublication(
    env,
    stage.publication.generation,
    dependencies,
    TRACK_HISTORY_PUBLICATION_ACTIONS.PAGE,
  );
  return {
    skipped: false,
    event: 'track_history_publication_step_completed',
    generation: stage.publication.generation,
    action: TRACK_HISTORY_PUBLICATION_ACTIONS.INITIALIZE,
    phase: stage.publication.phase,
    rows: 0,
    rows_written: 0,
    chunks: Number(stage.publication.next_chunk_index || 1),
    published: false,
  };
}

async function processPageStage(env, stage, generation, timestamp, dependencies) {
  if (!stage?.publication || String(stage.publication.generation || '') !== generation) {
    return { skipped: true, reason: 'track-history-publication-generation-stale', generation };
  }
  if (stage.published === true || stage.publication.phase === 'published') {
    return { skipped: true, reason: 'track-history-publication-already-published', generation };
  }
  const advance = dependencies.advancePublication || advanceTrackHistoryPublication;
  const result = await advance(env.MINUTE_DB, stage.publication, timestamp, dependencies);
  stage.publication = result.publication;
  stage.updated_at = timestamp;
  if (result.published) {
    stage.published = true;
    stage.published_at = timestamp;
  }
  const save = dependencies.saveStage || saveTrackHistoryStage;
  await save(env.MINUTE_DB, stage, timestamp);
  if (!result.published) {
    await enqueueTrackHistoryPublication(
      env,
      generation,
      dependencies,
      TRACK_HISTORY_PUBLICATION_ACTIONS.PAGE,
    );
  }
  return {
    skipped: false,
    event: 'track_history_publication_step_completed',
    generation,
    action: result.action,
    phase: stage.publication.phase,
    rows: Number(result.rows || 0),
    rows_written: Number(stage.publication.rows_written || 0),
    chunks: Number(result.chunks || 0),
    published: result.published === true,
  };
}

export async function processTrackHistoryPublicationTask(env, body, dependencies = {}) {
  const task = validateTask(body);
  if (!env?.MINUTE_DB) throw new Error('track-history publication MINUTE_DB binding is missing');
  const load = dependencies.loadStage || loadTrackHistoryStage;
  const stage = await load(env.MINUTE_DB);
  const timestamp = integer(dependencies.now?.()) ?? Date.now();
  if (task.action === TRACK_HISTORY_PUBLICATION_ACTIONS.STATUS) {
    return processStatusStage(env, stage, task.generation, timestamp, dependencies);
  }
  if (task.action === TRACK_HISTORY_PUBLICATION_ACTIONS.INITIALIZE) {
    return processInitializeStage(env, stage, task.generation, timestamp, dependencies);
  }
  return processPageStage(env, stage, task.generation, timestamp, dependencies);
}
