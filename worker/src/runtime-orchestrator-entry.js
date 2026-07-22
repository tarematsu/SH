import './fetch-guard.js';

import { budgetedLiveCompleteMessage } from './minute-live-complete-message.js';
import { rawCollectorEnv } from './runtime-env.js';

const EMPTY_DEPENDENCIES = Object.freeze({});
const LIVE_DERIVE_QUEUE_NAME = 'stationhead-minute-live-derive';
const RUNTIME_COORDINATOR_NAME = 'scheduled-v1';
const RUNTIME_COORDINATOR_TICKET_KEY = 'runtime:last-scheduled-ticket';

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
let runtimeScheduledModulePromise;
let liveTriggerModulePromise;
let liveRevisionModulePromise;
let liveWriteModulePromise;
let liveCompleteModulePromise;

function enabled(value, fallback = true) {
  if (value == null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.trunc(parsed) > 0 ? Math.trunc(parsed) : null;
}

function liveRevisionMaterializationEnabled(env = {}) {
  const value = env?.LIVE_REVISION_MATERIALIZATION_ENABLED;
  if (value == null || value === '') return enabled(env?.HISTORICAL_REBUILD_ENABLED, true);
  return enabled(value, true);
}

function lightweightLiveMessageKind(body) {
  if (body?.message_type === 'minute-fact-derive'
      && Number(body?.message_version) === 1
      && String(body?.job_kind || 'live') !== 'rebuild') return 'trigger';
  if (body?.message_type !== 'minute-fact-derive-stage'
      || Number(body?.message_version) !== 1) return null;
  if (body?.stage === 'revision-materialize'
      && body?.revision?.sparse === true
      && body?.revision?.rebuild !== true
      && positiveInteger(body?.revision?.revision_id) != null) return 'revision';
  if ((body?.stage === 'write' || body?.stage === 'budget-live-write')
      && positiveInteger(body?.job?.id) != null
      && body?.payload?.rebuild !== true
      && String(body?.job?.job_kind || 'live') !== 'rebuild') return 'write';
  if (budgetedLiveCompleteMessage(body)) return 'complete';
  return null;
}

export function lightweightLiveBudgetKind(batch, env) {
  if (String(batch?.queue || '') !== LIVE_DERIVE_QUEUE_NAME) return null;
  if (liveRevisionMaterializationEnabled(env)) return null;
  const messages = batch?.messages || [];
  if (!messages.length) return null;
  const kind = lightweightLiveMessageKind(messages[0]?.body);
  if (!kind) return null;
  return messages.every((message) => lightweightLiveMessageKind(message?.body) === kind)
    ? kind
    : null;
}

export function lightweightLiveCompleteBatch(batch, env) {
  return lightweightLiveBudgetKind(batch, env) === 'complete';
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

function loadRuntimeScheduledModule() {
  runtimeScheduledModulePromise ||= import('./runtime-scheduled.js');
  return runtimeScheduledModulePromise;
}

function loadLiveTriggerModule() {
  liveTriggerModulePromise ||= import('./minute-live-trigger-budget-entry.js');
  return liveTriggerModulePromise;
}

function loadLiveRevisionModule() {
  liveRevisionModulePromise ||= import('./minute-live-revision-budget-entry.js');
  return liveRevisionModulePromise;
}

function loadLiveWriteModule() {
  liveWriteModulePromise ||= import('./minute-live-write-budget-entry.js');
  return liveWriteModulePromise;
}

function loadLiveCompleteModule() {
  liveCompleteModulePromise ||= import('./minute-live-complete-budget-entry.js');
  return liveCompleteModulePromise;
}

async function runLightweightLiveQueue(kind, batch, env, dependencies) {
  if (kind === 'complete') {
    const run = dependencies.runLiveCompleteQueue
      || (await loadLiveCompleteModule()).processBudgetedLiveCompleteBatch;
    return run(batch, env, dependencies.liveComplete || EMPTY_DEPENDENCIES);
  }
  if (kind === 'trigger') {
    const run = dependencies.runLiveTriggerQueue
      || (await loadLiveTriggerModule()).processBudgetedLiveTriggerBatch;
    return run(batch, env, dependencies.liveTrigger || EMPTY_DEPENDENCIES);
  }
  if (kind === 'revision') {
    const run = dependencies.runLiveRevisionQueue
      || (await loadLiveRevisionModule()).processBudgetedLiveRevisionBatch;
    return run(batch, env, dependencies.liveRevision || EMPTY_DEPENDENCIES);
  }
  const run = dependencies.runLiveWriteQueue
    || (await loadLiveWriteModule()).processBudgetedLiveWriteBatch;
  return run(batch, env, dependencies.liveWrite || EMPTY_DEPENDENCIES);
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
  const liveKind = lightweightLiveBudgetKind(batch, env);
  if (liveKind) return runLightweightLiveQueue(liveKind, batch, env, dependencies);
  const run = dependencies.runRuntimeQueue || (await loadRuntimeQueueModule()).runRuntimeQueue;
  return run(batch, env, ctx, dependencies.runtime || EMPTY_DEPENDENCIES);
}

export async function runCoreScheduled(controller, env, ctx, dependencies = EMPTY_DEPENDENCIES) {
  const [runtimeModule, pagesModule] = await Promise.all([
    dependencies.runRuntimeScheduled ? null : loadRuntimeScheduledModule(),
    dependencies.runPagesScheduled || dependencies.dispatchPagesScheduled ? null : loadPagesModule(),
  ]);
  const runtime = dependencies.runRuntimeScheduled || runtimeModule.runRuntimeScheduled;
  const pages = dependencies.runPagesScheduled
    || dependencies.dispatchPagesScheduled
    || pagesModule.runPagesReadModelCron;
  const [runtimeResult, pagesResult] = await Promise.all([
    runtime(controller, env, ctx, dependencies.runtime || EMPTY_DEPENDENCIES),
    pages(controller, env, dependencies.pages || EMPTY_DEPENDENCIES),
  ]);
  return { runtime: runtimeResult, pages: pagesResult };
}

function coordinatorStub(namespace) {
  if (typeof namespace?.getByName === 'function') {
    return namespace.getByName(RUNTIME_COORDINATOR_NAME);
  }
  if (typeof namespace?.idFromName === 'function' && typeof namespace?.get === 'function') {
    return namespace.get(namespace.idFromName(RUNTIME_COORDINATOR_NAME));
  }
  return null;
}

export async function runCoordinatedScheduled(
  controller,
  env,
  ctx,
  dependencies = EMPTY_DEPENDENCIES,
) {
  const direct = dependencies.runDirect || runCoreScheduled;
  const stub = dependencies.stub || coordinatorStub(env?.RUNTIME_COORDINATOR);
  if (typeof stub?.claim !== 'function') return direct(controller, env, ctx, dependencies.direct);
  try {
    const claim = await stub.claim({
      cron: String(controller?.cron || ''),
      scheduledTime: Number(controller?.scheduledTime) || Date.now(),
    });
    if (!claim?.claimed) {
      return { skipped: true, reason: claim?.reason || 'runtime-coordinator-duplicate' };
    }
    const coordinatedEnv = Object.create(env || null);
    Object.defineProperty(coordinatedEnv, 'PRIMARY_RUN_LOCK_ENABLED', {
      value: false,
      enumerable: false,
    });
    return await direct(controller, coordinatedEnv, ctx, dependencies.direct);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'runtime_coordinator_failed',
      error: String(error?.message || error).slice(0, 500),
    }));
    return { skipped: true, reason: 'runtime-coordinator-error' };
  }
}

// One object grants at most one ticket for each scheduled tick. The potentially
// slow network and D1 work runs in the calling Worker after the short RPC, so DO
// active time stays bounded. One overwritten storage row replaces the D1 lease;
// the D1 path remains available when the DO binding is unavailable.
export class RuntimeCoordinator {
  constructor(state) {
    this.state = state;
    this.lastTicket = null;
  }

  async claim(controller = {}) {
    const cron = String(controller?.cron || '');
    const scheduledAt = Number(controller?.scheduledTime) || Date.now();
    const ticket = `${cron}:${scheduledAt}`;
    const storage = this.state?.storage;
    const previous = typeof storage?.get === 'function'
      ? await storage.get(RUNTIME_COORDINATOR_TICKET_KEY)
      : this.lastTicket;
    if (previous === ticket) {
      return { claimed: false, reason: 'runtime-coordinator-duplicate' };
    }
    if (typeof storage?.put === 'function') {
      await storage.put(RUNTIME_COORDINATOR_TICKET_KEY, ticket);
    }
    this.lastTicket = ticket;
    return { claimed: true };
  }
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
  scheduled: runCoordinatedScheduled,
  queue: runCoreQueue,
};
