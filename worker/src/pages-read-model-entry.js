import './fetch-guard.js';
import { materializedResponseMaximumAge } from '../../site/functions/lib/api-contract.js';
import { runDispatchedPagesReadModelTask } from './pages-read-model-dispatch.js';
import { loadMaterializedResponse } from './pages-response-store.js';
import { processReadModelBatch } from './read-model-entry.js';

export const PAGES_READ_MODEL_CRON = '* * * * *';
export const MINUTE_READ_MODEL_QUEUE = 'stationhead-read-model';
const EMPTY_DEPENDENCIES = Object.freeze({});
const INTERNAL_RESPONSE_PATH = '/_internal/pages-response';

let publicationModulePromise;

function loadPublicationModule() {
  publicationModulePromise ||= import('./pages-track-history-publication-queue.js');
  return publicationModulePromise;
}

function scheduledTimestamp(controller) {
  const value = controller?.scheduledTime;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : Date.now();
  }
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now();
}

function assertRefreshSucceeded(result) {
  if (!result || typeof result !== 'object') return result;
  const declaredFailed = Number(result.failed);
  if (declaredFailed === 0) return result;

  const responses = result.responses;
  let failures = null;
  if (Array.isArray(responses)) {
    const responseCount = responses.length;
    for (let index = 0; index < responseCount; index += 1) {
      const item = responses[index];
      if (item?.ok !== false) continue;
      if (failures) failures.push(item);
      else failures = [item];
    }
  }
  const responseFailureCount = failures?.length || 0;
  if (declaredFailed > 0 || responseFailureCount > 0) {
    const task = result.task?.key || result.task?.kind || 'unknown';
    const errors = new Array(responseFailureCount);
    for (let index = 0; index < responseFailureCount; index += 1) {
      const item = failures[index];
      errors[index] = new Error(`${item.key || task}: ${item.error || 'materialization failed'}`);
    }
    throw new AggregateError(
      errors,
      `Pages read-model task ${task} failed for ${responseFailureCount || declaredFailed} response(s)`,
    );
  }
  return result;
}

export async function runPagesReadModelFetch(request, env, dependencies = EMPTY_DEPENDENCIES) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== INTERNAL_RESPONSE_PATH) {
    return new Response(null, { status: 404 });
  }
  const modelKey = String(url.searchParams.get('key') || '').trim();
  if (!modelKey) return new Response(null, { status: 400 });
  const now = dependencies.now?.() ?? Date.now();
  const load = dependencies.loadResponse || loadMaterializedResponse;
  try {
    const response = await load(
      env?.PAGES_RESPONSE_KV,
      modelKey,
      now,
      materializedResponseMaximumAge(modelKey, env),
    );
    return response || new Response(null, {
      status: 404,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'pages_response_kv_read_failed',
      model_key: modelKey,
      error: String(error?.message || error).slice(0, 500),
    }));
    return new Response(null, {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    });
  }
}

export async function runPagesReadModelCron(controller, env, dependencies = EMPTY_DEPENDENCIES) {
  const rawCron = controller?.cron;
  let cron = rawCron;
  if (cron !== PAGES_READ_MODEL_CRON) {
    cron = String(rawCron || '');
    if (cron !== PAGES_READ_MODEL_CRON) {
      return { skipped: true, reason: 'unsupported-pages-read-model-cron', cron };
    }
  }
  const now = scheduledTimestamp(controller);
  const runTask = dependencies.runTask || runDispatchedPagesReadModelTask;
  return assertRefreshSucceeded(await runTask(env, now, dependencies));
}

export async function runPagesReadModelQueue(batch, env, dependencies = EMPTY_DEPENDENCIES) {
  if (String(batch?.queue || '') === MINUTE_READ_MODEL_QUEUE) {
    const runMinuteReadModel = dependencies.processReadModelBatch || processReadModelBatch;
    return runMinuteReadModel(batch, env);
  }
  const messages = batch.messages;
  if (!messages?.length) return;
  const message = messages[0];
  const processPublication = dependencies.processTrackHistoryPublicationTask
    || (await loadPublicationModule()).processTrackHistoryPublicationTask;
  try {
    const result = await processPublication(env, message.body, dependencies);
    console.log(JSON.stringify(result));
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({
      event: 'track_history_publication_step_failed',
      error: String(error?.message || error).slice(0, 800),
    }));
    message.retry();
  }
}

export default {
  fetch: runPagesReadModelFetch,
  scheduled: runPagesReadModelCron,
  queue: runPagesReadModelQueue,
};
