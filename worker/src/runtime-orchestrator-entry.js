import './fetch-guard.js';

import {
  budgetedLiveCompleteMessage,
  processBudgetedLiveCompleteBatch,
} from './minute-live-complete-budget-entry.js';
import { dispatchPagesReadModelScheduled } from './pages-read-model-scheduled-dispatch.js';
import { rawCollectorEnv } from './runtime-env.js';
import { runRuntimeScheduled as runRuntimeDispatchScheduled } from './runtime-scheduled.js';

const EMPTY_DEPENDENCIES = Object.freeze({});
const LIVE_DERIVE_QUEUE_NAME = 'stationhead-minute-live-derive';

const INGEST_QUEUE_NAMES = new Set([
  'stationhead-raw-collection',
  'stationhead-ingest-finalize',
  'stationhead-comments',
  'stationhead-buddies-persist',
]);
const ENRICHMENT_QUEUE_NAMES = new Set([
  'stationhead-minute-enrichment',
  'stationhead-track-metadata',
]);
const PAGES_QUEUE_NAMES = new Set([
  'stationhead-pages-read-model-publication',
  'stationhead-read-model',
]);

let ingestModulePromise;
let enrichmentModulePromise;
let pagesModulePromise;
let runtimeQueueModulePromise;

function enabled(value, fallback = true) {
  if (value == null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function liveRevisionMaterializationEnabled(env = {}) {
  const value = env?.LIVE_REVISION_MATERIALIZATION_ENABLED;
  if (value == null || value === '') return enabled(env?.HISTORICAL_REBUILD_ENABLED, true);
  return enabled(value, true);
}

export function lightweightLiveCompleteBatch(batch, env) {
  if (String(batch?.queue || '') !== LIVE_DERIVE_QUEUE_NAME) return false;
  if (liveRevisionMaterializationEnabled(env)) return false;
  const messages = batch?.messages || [];
  return messages.length > 0
    && messages.every((message) => budgetedLiveCompleteMessage(message?.body));
}

function loadIngestModule() {
  ingestModulePromise ||= import('./ingest-channel-optimized-entry.js');
  return ingestModulePromise;
}

function loadEnrichmentModule() {
  enrichmentModulePromise ||= import('./minute-enrichment-optimized-entry.js');
  return enrichmentModulePromise;
}

function loadPagesModule() {
  pagesModulePromise ||= import('./pages-read-model-entry.js');
  return pagesModulePromise;
}

function loadRuntimeQueueModule() {
  runtimeQueueModulePromise ||= import('./runtime-queue.js');
  return runtimeQueueModulePromise;
}

export async function runCoreQueue(batch, env, ctx, dependencies = EMPTY_DEPENDENCIES) {
  const queueName = String(batch?.queue || '');
  if (INGEST_QUEUE_NAMES.has(queueName)) {
    const run = dependencies.runIngestQueue || (await loadIngestModule()).default.queue;
    return run(batch, rawCollectorEnv(env), ctx, dependencies.ingest || EMPTY_DEPENDENCIES);
  }
  if (PAGES_QUEUE_NAMES.has(queueName)) {
    const run = dependencies.runPagesQueue || (await loadPagesModule()).runPagesReadModelQueue;
    return run(batch, env, dependencies.pages || EMPTY_DEPENDENCIES);
  }
  if (ENRICHMENT_QUEUE_NAMES.has(queueName)) {
    const run = dependencies.runEnrichmentQueue
      || (await loadEnrichmentModule()).processConsolidatedEnrichmentBatch;
    return run(batch, env, dependencies.enrichment || EMPTY_DEPENDENCIES);
  }
  if (lightweightLiveCompleteBatch(batch, env)) {
    const run = dependencies.runLiveCompleteQueue || processBudgetedLiveCompleteBatch;
    return run(batch, env, dependencies.liveComplete || EMPTY_DEPENDENCIES);
  }
  const run = dependencies.runRuntimeQueue || (await loadRuntimeQueueModule()).runRuntimeQueue;
  return run(batch, env, ctx, dependencies.runtime || EMPTY_DEPENDENCIES);
}

export async function runCoreScheduled(controller, env, ctx, dependencies = EMPTY_DEPENDENCIES) {
  const runtime = dependencies.runRuntimeScheduled || runRuntimeDispatchScheduled;
  const pages = dependencies.dispatchPagesScheduled || dispatchPagesReadModelScheduled;
  const [runtimeResult, pagesResult] = await Promise.all([
    runtime(controller, env, ctx, dependencies.runtime || EMPTY_DEPENDENCIES),
    pages(controller, env, dependencies.pages || EMPTY_DEPENDENCIES),
  ]);
  return { runtime: runtimeResult, pages: pagesResult };
}

export async function runCoreFetch(request, env, ctx, dependencies = EMPTY_DEPENDENCIES) {
  const run = dependencies.runPagesFetch || (await loadPagesModule()).runPagesReadModelFetch;
  return run(request, env, ctx, dependencies.pages || EMPTY_DEPENDENCIES);
}

export {
  ENRICHMENT_QUEUE_NAMES,
  INGEST_QUEUE_NAMES,
  PAGES_QUEUE_NAMES,
};

export default {
  fetch: runCoreFetch,
  scheduled: runCoreScheduled,
  queue: runCoreQueue,
};
