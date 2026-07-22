const QUEUE_PLAN_PREFIX = 'operational/queue-plan/v1/';

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function cacheKey(body) {
  const stationId = integer(body?.data?.station_id);
  return stationId == null ? null : `${QUEUE_PLAN_PREFIX}${stationId}.json`;
}

function incomingHashes(body) {
  const structuralHash = body?.analysis?.structural_hash;
  const likesHash = body?.analysis?.likes_hash;
  return {
    structural_hash: typeof structuralHash === 'string' ? structuralHash : null,
    likes_hash: typeof likesHash === 'string' ? likesHash : null,
  };
}

async function parsedObject(object) {
  if (typeof object?.json === 'function') return object.json();
  if (typeof object?.text === 'function') return JSON.parse(await object.text());
  return null;
}

export async function invalidateQueuePlanR2(r2, body) {
  const key = cacheKey(body);
  if (!key || typeof r2?.delete !== 'function') return false;
  await r2.delete(key);
  return true;
}

export async function loadQueuePlanR2(r2, body, observedAt, forceRefresh = false) {
  const key = cacheKey(body);
  if (!key || typeof r2?.get !== 'function') return null;
  let object;
  try {
    object = await r2.get(key);
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'queue_plan_r2_read_failed',
      error: String(error?.message || error).slice(0, 500),
    }));
    return null;
  }
  if (!object) return null;
  let cached;
  try {
    cached = await parsedObject(object);
  } catch {
    cached = null;
  }
  const incoming = incomingHashes(body);
  const timestamp = integer(observedAt);
  const matches = Number(cached?.version) === 1
    && cached.structural_hash === incoming.structural_hash
    && cached.likes_hash === incoming.likes_hash
    && integer(cached.station_id) === integer(body?.data?.station_id)
    && integer(cached.queue_id) === integer(body?.data?.queue_id)
    && integer(cached.start_time) === integer(body?.data?.start_time)
    && timestamp != null
    && timestamp >= (integer(cached.observed_at) ?? 0);
  if (forceRefresh || !matches) {
    if (typeof r2?.delete !== 'function') return null;
    await r2.delete(key);
    return null;
  }
  return {
    structure_changed: false,
    snapshot_required: false,
    stale_current: false,
    station_id: integer(cached.station_id),
    queue_id: integer(cached.queue_id),
    start_time: integer(cached.start_time),
    structural_hash: cached.structural_hash,
    likes_hash: cached.likes_hash,
    all_positions: [],
    write_positions: [],
    claim: {
      accepted: false,
      duplicate: true,
      reason: 'r2-queue-plan-hit',
      hash: cached.structural_hash,
    },
    r2_cache_hit: true,
  };
}

export async function saveQueuePlanR2(r2, body, observedAt, plan) {
  const key = cacheKey(body);
  if (!key || typeof r2?.put !== 'function' || plan?.blocked || plan?.stale_current) return false;
  const structuralHash = plan?.structural_hash;
  const likesHash = plan?.likes_hash;
  if (typeof structuralHash !== 'string' || typeof likesHash !== 'string') return false;
  await r2.put(key, JSON.stringify({
    version: 1,
    station_id: integer(plan.station_id),
    queue_id: integer(plan.queue_id),
    start_time: integer(plan.start_time),
    structural_hash: structuralHash,
    likes_hash: likesHash,
    observed_at: integer(observedAt),
  }), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  return true;
}

export { QUEUE_PLAN_PREFIX };
