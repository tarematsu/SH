import './fetch-guard.js';

import { dispatchPagesReadModelScheduled } from './pages-read-model-scheduled-dispatch.js';
import { rawCollectorEnv } from './runtime-env.js';
import { runRuntimeScheduled as runRuntimeDispatchScheduled } from './runtime-scheduled.js';

const EMPTY_DEPENDENCIES = Object.freeze({});

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
    const ingest = await loadIngestModule();
    const run = dependencies.runIngestQueue || ingest.default.queue;
    return run(batch, rawCollectorEnv(env), ctx, dependencies.ingest || EMPTY_DEPENDENCIES);
  }
  if (PAGES_QUEUE_NAMES.has(queueName)) {
    const pages = await loadPagesModule();
    const run = dependencies.runPagesQueue || pages.runPagesReadModelQueue;
    return run(batch, env, dependencies.pages || EMPTY_DEPENDENCIES);
  }
  if (ENRICHMENT_QUEUE_NAMES.has(queueName)) {
    const enrichment = await loadEnrichmentModule();
    const run = dependencies.runEnrichmentQueue || enrichment.processConsolidatedEnrichmentBatch;
    return run(batch, env, dependencies.enrichment || EMPTY_DEPENDENCIES);
  }
  const runtime = await loadRuntimeQueueModule();
  const run = dependencies.runRuntimeQueue || runtime.runRuntimeQueue;
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
  const pages = await loadPagesModule();
  const run = dependencies.runPagesFetch || pages.runPagesReadModelFetch;
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
