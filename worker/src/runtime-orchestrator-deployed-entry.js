import baseWorker, {
  RuntimeCoordinator as StoredRuntimeCoordinator,
  runCoreScheduled,
} from './runtime-orchestrator-entry.js';

const RUNTIME_COORDINATOR_NAME = 'scheduled-v1';
const DEFAULT_COORDINATOR_LEASE_MS = 70_000;
const MIN_COORDINATOR_LEASE_MS = 30_000;
const MAX_COORDINATOR_LEASE_MS = 180_000;
const COORDINATOR_URL = 'https://runtime-coordinator.internal/lease';

function coordinatorLeaseMs(value) {
  const parsed = Number(value ?? DEFAULT_COORDINATOR_LEASE_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_COORDINATOR_LEASE_MS;
  return Math.max(
    MIN_COORDINATOR_LEASE_MS,
    Math.min(MAX_COORDINATOR_LEASE_MS, Math.trunc(parsed)),
  );
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

async function coordinatorRequest(stub, body) {
  if (typeof stub?.fetch !== 'function') {
    throw new Error('runtime coordinator fetch binding is unavailable');
  }
  const response = await stub.fetch(COORDINATOR_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response?.ok) {
    const detail = typeof response?.text === 'function' ? await response.text() : '';
    throw new Error(`runtime coordinator HTTP ${response?.status || 500}: ${detail.slice(0, 300)}`);
  }
  return response.json();
}

export async function runFetchCoordinatedScheduled(controller, env, ctx, dependencies = {}) {
  const direct = dependencies.runDirect || runCoreScheduled;
  const stub = dependencies.stub || coordinatorStub(env?.RUNTIME_COORDINATOR);
  if (typeof stub?.fetch !== 'function') {
    return direct(controller, env, ctx, dependencies.direct);
  }

  let claim;
  try {
    claim = await coordinatorRequest(stub, {
      action: 'claim',
      cron: String(controller?.cron || ''),
      scheduledTime: Number(controller?.scheduledTime) || Date.now(),
      leaseMs: coordinatorLeaseMs(env?.PRIMARY_RUN_LOCK_TTL_MS),
    });
  } catch (error) {
    coordinatorFailure('runtime_coordinator_claim_failed', error);
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

  const result = await direct(controller, coordinatedEnv, ctx, dependencies.direct);
  if (claim.holder_id) {
    try {
      await coordinatorRequest(stub, {
        action: 'release',
        holder_id: claim.holder_id,
      });
    } catch (error) {
      coordinatorFailure('runtime_coordinator_release_failed', error);
    }
  }
  return result;
}

async function skipDedicatedRawCollection() {
  return { skipped: true, reason: 'dedicated-buddies-collector' };
}

export async function runRuntimeOrchestratorScheduled(
  controller,
  env,
  ctx,
  dependencies = {},
) {
  const direct = dependencies.direct || {};
  const runtime = direct.runtime || {};
  return runFetchCoordinatedScheduled(controller, env, ctx, {
    ...dependencies,
    direct: {
      ...direct,
      runtime: {
        ...runtime,
        dispatchRawCollection: runtime.dispatchRawCollection || skipDedicatedRawCollection,
      },
    },
  });
}

// Fetch-based Durable Object dispatch works with both legacy and current module
// syntax and avoids invoking RPC methods on a class that does not extend the
// special DurableObject base class.
export class RuntimeCoordinator extends StoredRuntimeCoordinator {
  async fetch(request) {
    if (request?.method !== 'POST') {
      return Response.json({ error: 'method-not-allowed' }, { status: 405 });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'invalid-json' }, { status: 400 });
    }
    if (body?.action === 'claim') {
      return Response.json(await this.claim(body));
    }
    if (body?.action === 'release') {
      return Response.json(await this.release(body?.holder_id, body?.released_at));
    }
    return Response.json({ error: 'invalid-action' }, { status: 400 });
  }
}

export default {
  fetch: baseWorker.fetch,
  queue: baseWorker.queue,
  scheduled: runRuntimeOrchestratorScheduled,
};
