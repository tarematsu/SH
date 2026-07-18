import { advanceTrackHistoryPublication } from './pages-track-history-publication.js';
import {
  loadTrackHistoryStage,
  saveTrackHistoryStage,
} from './pages-track-history-stage.js';

export const TRACK_HISTORY_PUBLICATION_MESSAGE = 'stationhead-pages-track-history-publication';
export const TRACK_HISTORY_PUBLICATION_STALE_MS = 2 * 60_000;

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function taskBody(generation) {
  return {
    message_type: TRACK_HISTORY_PUBLICATION_MESSAGE,
    message_version: 1,
    generation: String(generation || ''),
  };
}

export async function enqueueTrackHistoryPublication(env, generation, dependencies = {}) {
  const send = dependencies.sendPublication
    || ((body) => env?.PAGES_READ_MODEL_QUEUE?.send(body, { contentType: 'json' }));
  if (!dependencies.sendPublication && !env?.PAGES_READ_MODEL_QUEUE?.send) {
    throw new Error('PAGES_READ_MODEL_QUEUE binding is missing');
  }
  await send(taskBody(generation));
}

export function trackHistoryPublicationStalled(stage, now = Date.now()) {
  if (!stage?.publication || stage.published === true) return false;
  const updatedAt = integer(stage.publication.updated_at ?? stage.updated_at);
  return updatedAt == null || Number(now) - updatedAt >= TRACK_HISTORY_PUBLICATION_STALE_MS;
}

function validateTask(body) {
  if (body?.message_type !== TRACK_HISTORY_PUBLICATION_MESSAGE
      || integer(body?.message_version) !== 1
      || !String(body?.generation || '').trim()) {
    throw new Error('invalid track-history publication task');
  }
  return String(body.generation);
}

export async function processTrackHistoryPublicationTask(env, body, dependencies = {}) {
  const generation = validateTask(body);
  if (!env?.MINUTE_DB) throw new Error('track-history publication MINUTE_DB binding is missing');
  const load = dependencies.loadStage || loadTrackHistoryStage;
  const stage = await load(env.MINUTE_DB);
  if (!stage?.publication || String(stage.publication.generation || '') !== generation) {
    return { skipped: true, reason: 'track-history-publication-generation-stale', generation };
  }
  if (stage.published === true || stage.publication.phase === 'published') {
    return { skipped: true, reason: 'track-history-publication-already-published', generation };
  }

  const advance = dependencies.advancePublication || advanceTrackHistoryPublication;
  const timestamp = integer(dependencies.now?.()) ?? Date.now();
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
    await enqueueTrackHistoryPublication(env, generation, dependencies);
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
