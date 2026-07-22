import './fetch-guard.js';

import { budgetedLiveCompleteMessage } from './minute-live-complete-message.js';
import { rawCollectorEnv } from './runtime-env.js';

const EMPTY_DEPENDENCIES = Object.freeze({});
const LIVE_DERIVE_QUEUE_NAME = 'stationhead-minute-live-derive';
const RUNTIME_COORDINATOR_NAME = 'scheduled-v1';
const RUNTIME_COORDINATOR_TICKET_KEY = 'runtime:last-scheduled-ticket';
const DEFAULT_COORDINATOR_LEASE_MS = 70_000;
const MIN_COORDINATOR_LEASE_MS = 30_000;
const MAX_COORDINATOR_LEASE_MS = 180_000;

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

function coordinatorLeaseMs(value) {
  const parsed = Number(value ?? DEFAULT_COORDINATOR_LEASE_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_COORDINATOR_LEASE_MS;
  return Math.max(
    MIN_COORDINATOR_LEASE_MS,
    Math.min(MAX_COORDINATOR_LEASE_MS, Math.trunc(parsed)),
  );
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

function coordinatorFailure(event, error) {
  console.error(JSON.stringify({
    event,
    error: String(error?.message || error).slice(0, 500),
  }));
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

  let claim;
  try {
    claim = await stub.claim({
      cron: String(controller?.cron || ''),
      scheduledTime: Number(controller?.scheduledTime) || Date.now(),
      leaseMs: coordinatorLeaseMs(env?.PRIMARY_RUN_LOCK_TTL_MS),
    });
  } catch (error) {
    coordinatorFailure('runtime_coordinator_claim_failed', error);
    // Preserve availability and overlap protection by falling back to the
    // existing D1 lease. The direct path receives the original environment,
    // so PRIMARY_RUN_LOCK_ENABLED remains unchanged.
    return direct(controller, env, ctx, dependencies.direct);
  }

  if (!claim?.claimed) {
    return { skipped: true, reason: claim?.reason || 'runtime-coordinator-duplicate' };
  }

  const coordinatedEnv = Object.create(env || null);
  Object.defineProperty(coordinatedEnv, 'PRIMARY_RUN_LOCK_ENABLED', {
    value: false,
    enumerable: false,
  });

  // Do not release on an error or timeout. The underlying collection may still
  // be winding down after its await is aborted, so the lease must expire by TTL
  // just like the previous D1 lock.
  const result = await direct(controller, coordinatedEnv, ctx, dependencies.direct);
  if (typeof stub.release === 'function' && claim.holder_id) {
    try {
      await stub.release(claim.holder_id);
    } catch (error) {
      coordinatorFailure('runtime_coordinator_release_failed', error);
    }
  }
  return result;
}

function storedLease(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ticket = typeof value.ticket === 'string' ? value.ticket : '';
  const holderId = typeof value.holder_id === 'string' ? value.holder_id : '';
  const leaseUntil = Number(value.lease_until);
  if (!ticket || !holderId || !Number.isFinite(leaseUntil)) return null;
  return { ...value, ticket, holder_id: holderId, lease_until: leaseUntil };
}

// One object serializes scheduled ticks and owns the short overlap lease. Slow
// network and D1 work remains in the calling Worker, so the DO only reads and
// overwrites one small row for claim/release. The D1 lease remains the fail-open
// fallback when the binding or claim RPC is unavailable.
export class RuntimeCoordinator {
  constructor(state) {
    this.state = state;
    this.lastLease = null;
  }

  async claim(controller = {}) {
    const cron = String(controller?.cron || '');
    const scheduledAt = Number(controller?.scheduledTime) || Date.now();
    const now = Number(controller?.now) || Date.now();
    const ticket = `${cron}:${scheduledAt}`;
    const storage = this.state?.storage;
    const stored = typeof storage?.get === 'function'
      ? await storage.get(RUNTIME_COORDINATOR_TICKET_KEY)
      : this.lastLease;
    const previous = storedLease(stored);

    // Accept the previous string format long enough to preserve duplicate-tick
    // suppression across a rolling deployment, then overwrite it as v2 below.
    if (stored === ticket || previous?.ticket === ticket) {
      return { claimed: false, reason: 'runtime-coordinator-duplicate' };
    }
    if (previous && previous.lease_until > now) {
      return {
        claimed: false,
        reason: 'primary-run-in-progress',
        lease_until: previous.lease_until,
      };
    }

    const lease = {
      version: 2,
      ticket,
      holder_id: ticket,
      claimed_at: now,
      lease_until: now + coordinatorLeaseMs(controller?.leaseMs),
    };
    if (typeof storage?.put === 'function') {
      await storage.put(RUNTIME_COORDINATOR_TICKET_KEY, lease);
    }
    this.lastLease = lease;
    return {
      claimed: true,
      holder_id: lease.holder_id,
      lease_until: lease.lease_until,
    };
  }

  async release(holderId, releasedAt = Date.now()) {
    const storage = this.state?.storage;
    const stored = typeof storage?.get === 'function'
      ? await storage.get(RUNTIME_COORDINATOR_TICKET_KEY)
      : this.lastLease;
    const current = storedLease(stored);
    if (!current || current.holder_id !== String(holderId || '')) {
      return { released: false, reason: 'runtime-coordinator-owner-mismatch' };
    }
    const now = Number(releasedAt) || Date.now();
    const released = {
      ...current,
      lease_until: Math.min(current.lease_until, now),
      released_at: now,
    };
    if (typeof storage?.put === 'function') {
      await storage.put(RUNTIME_COORDINATOR_TICKET_KEY, released);
    }
    this.lastLease = released;
    return { released: true };
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
