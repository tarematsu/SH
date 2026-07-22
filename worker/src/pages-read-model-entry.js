import './fetch-guard.js';
import { materializedResponseMaximumAge } from '../../site/functions/lib/api-contract.js';

export const PAGES_READ_MODEL_CRON = '* * * * *';
export const MINUTE_READ_MODEL_QUEUE = 'stationhead-read-model';
export const PAGES_READ_MODEL_DISPATCH_MESSAGE = 'stationhead-pages-read-model-dispatch';
const MINUTE_READ_MODEL_MESSAGE = 'stationhead-read-model';
const TRACK_HISTORY_MODEL_KEY = 'track-history';
const EMPTY_DEPENDENCIES = Object.freeze({});
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
const INTERNAL_RESPONSE_PATH = '/_internal/pages-response';
const MINUTE_MS = 60_000;
const PAGES_CYCLE_MINUTES = 6 * 60;

let publicationModulePromise;
let cronModulePromise;
let readModelQueueModulePromise;
let responseR2ModulePromise;
let responseStoreModulePromise;

function loadCronModule() {
  cronModulePromise ||= import('./pages-read-model-dispatch.js');
  return cronModulePromise;
}

function loadReadModelQueueModule() {
  readModelQueueModulePromise ||= import('./read-model-entry.js');
  return readModelQueueModulePromise;
}

function loadResponseR2Module() {
  responseR2ModulePromise ||= import('./pages-response-r2.js');
  return responseR2ModulePromise;
}

function loadResponseStoreModule() {
  responseStoreModulePromise ||= import('./pages-response-store.js');
  return responseStoreModulePromise;
}

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

function cycleMinute(timestamp) {
  const absoluteMinute = Math.floor(timestamp / MINUTE_MS);
  return ((absoluteMinute % PAGES_CYCLE_MINUTES) + PAGES_CYCLE_MINUTES) % PAGES_CYCLE_MINUTES;
}

export function pagesVariantDispatchDue(timestamp) {
  switch (cycleMinute(timestamp)) {
    case 35:
    case 50:
    case 70:
    case 105:
    case 140:
      return true;
    default:
      return false;
  }
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

function minuteReadModelBatch(batch) {
  if (String(batch?.queue || '') === MINUTE_READ_MODEL_QUEUE) return true;
  const body = batch?.messages?.[0]?.body;
  return body?.message_type === MINUTE_READ_MODEL_MESSAGE;
}

function edgeCache(dependencies) {
  return dependencies.cache || globalThis.caches?.default || null;
}

function edgeCacheKey(request, dependencies) {
  if (dependencies.cacheKey) return dependencies.cacheKey(request);
  return new Request(request.url, { method: 'GET' });
}

function freshMaterializedResponse(response, now, maximumAge) {
  const updatedAt = Number(response?.headers?.get('x-materialized-at'));
  const age = Number(maximumAge);
  if (!Number.isFinite(updatedAt) || updatedAt < 0) return null;
  if (Number.isFinite(age) && age >= 0 && now - updatedAt > age) return null;
  const clone = response.clone();
  const headers = new Headers(clone.headers);
  headers.set('x-api-source', 'edge-cache');
  return new Response(clone.body, { status: clone.status, headers });
}

async function loadEdgeCachedResponse(cache, key, now, maximumAge) {
  if (!cache?.match) return null;
  try {
    return freshMaterializedResponse(await cache.match(key), now, maximumAge);
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'pages_response_edge_cache_read_failed',
      error: String(error?.message || error).slice(0, 300),
    }));
    return null;
  }
}

function cacheResponse(cache, key, response, context) {
  if (!cache?.put || !response?.headers?.get('x-materialized-at')) return null;
  const write = cache.put(key, response.clone()).catch((error) => {
    console.warn(JSON.stringify({
      event: 'pages_response_edge_cache_write_failed',
      error: String(error?.message || error).slice(0, 300),
    }));
  });
  if (context?.waitUntil) context.waitUntil(write);
  return context?.waitUntil ? null : write;
}

export async function runPagesReadModelFetch(
  request,
  env,
  contextOrDependencies = EMPTY_DEPENDENCIES,
  injectedDependencies = EMPTY_DEPENDENCIES,
) {
  const context = typeof contextOrDependencies?.waitUntil === 'function'
    ? contextOrDependencies
    : null;
  const dependencies = context ? injectedDependencies : contextOrDependencies;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== INTERNAL_RESPONSE_PATH) {
    return new Response(null, { status: 404 });
  }
  const modelKey = String(url.searchParams.get('key') || '').trim();
  if (!modelKey) return new Response(null, { status: 400 });
  const now = dependencies.now?.() ?? Date.now();
  const maximumAge = materializedResponseMaximumAge(modelKey, env);
  const cache = edgeCache(dependencies);
  const cacheKey = edgeCacheKey(request, dependencies);
  try {
    const edgeResponse = await loadEdgeCachedResponse(cache, cacheKey, now, maximumAge);
    if (edgeResponse) return edgeResponse;

    const loadR2 = dependencies.loadR2Response
      || (await loadResponseR2Module()).loadMaterializedR2Response;
    const loadKv = dependencies.loadResponse
      || (await loadResponseStoreModule()).loadMaterializedResponse;
    const r2Response = modelKey === TRACK_HISTORY_MODEL_KEY
      ? await loadR2(env?.PAGES_RESPONSE_R2, modelKey, now, maximumAge)
      : null;
    const response = r2Response || await loadKv(
      env?.PAGES_RESPONSE_KV,
      modelKey,
      now,
      maximumAge,
    );
    if (response) await cacheResponse(cache, cacheKey, response, context);
    return response || new Response(null, {
      status: 404,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'pages_response_storage_read_failed',
      model_key: modelKey,
      error: String(error?.message || error).slice(0, 500),
    }));
    return new Response(null, {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    });
  }
}

async function dispatchPagesVariant(env, timestamp, dependencies) {
  const send = dependencies.sendScheduledTask
    || ((body) => env?.PAGES_READ_MODEL_QUEUE?.send(body, JSON_QUEUE_SEND_OPTIONS));
  if (!dependencies.sendScheduledTask && !env?.PAGES_READ_MODEL_QUEUE?.send) {
    throw new Error('PAGES_READ_MODEL_QUEUE binding is missing');
  }
  await send({
    message_type: PAGES_READ_MODEL_DISPATCH_MESSAGE,
    message_version: 1,
    scheduled_at: timestamp,
  });
  return {
    dispatched: true,
    task: 'pages-read-model-variant',
    scheduled_at: timestamp,
  };
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
  if (!dependencies.runTask && pagesVariantDispatchDue(now)) {
    return dispatchPagesVariant(env, now, dependencies);
  }
  const runTask = dependencies.runTask
    || (await loadCronModule()).runDispatchedPagesReadModelTask;
  return assertRefreshSucceeded(await runTask(env, now, dependencies));
}

function dispatchedPagesTask(body) {
  return body?.message_type === PAGES_READ_MODEL_DISPATCH_MESSAGE
    && Number(body?.message_version) === 1
    && Number.isFinite(Number(body?.scheduled_at));
}

async function processDispatchedPagesTask(message, env, dependencies) {
  try {
    const runTask = dependencies.runTask
      || (await loadCronModule()).runDispatchedPagesReadModelTask;
    const result = assertRefreshSucceeded(await runTask(
      env,
      scheduledTimestamp({ scheduledTime: message.body.scheduled_at }),
      dependencies,
    ));
    console.log(JSON.stringify({ event: 'pages_read_model_variant_completed', ...result }));
    message.ack();
    return result;
  } catch (error) {
    console.error(JSON.stringify({
      event: 'pages_read_model_variant_failed',
      error: String(error?.message || error).slice(0, 800),
    }));
    message.retry();
    return null;
  }
}

export async function runPagesReadModelQueue(batch, env, dependencies = EMPTY_DEPENDENCIES) {
  const messages = batch?.messages;
  if (!messages?.length) return;
  const message = messages[0];
  if (dispatchedPagesTask(message.body)) {
    return processDispatchedPagesTask(message, env, dependencies);
  }
  if (minuteReadModelBatch(batch)) {
    const runMinuteReadModel = dependencies.processReadModelBatch
      || (await loadReadModelQueueModule()).processReadModelBatch;
    return runMinuteReadModel(batch, env);
  }
  const processPublication = dependencies.processTrackHistoryPublicationTask
    || (await loadPublicationModule()).processTrackHistoryPublicationTask;
  try {
    const result = await processPublication(env, message.body, dependencies);
    console.log(JSON.stringify(result));
    message.ack();
    return result;
  } catch (error) {
    console.error(JSON.stringify({
      event: 'track_history_publication_step_failed',
      error: String(error?.message || error).slice(0, 800),
    }));
    message.retry();
    return null;
  }
}

export default {
  fetch: runPagesReadModelFetch,
  scheduled: runPagesReadModelCron,
  queue: runPagesReadModelQueue,
};
