import { onRequestPost as corePost, onRequestGet } from './ingest-core.js';
import {
  authorized,
  json,
  observedAtFrom,
  readJsonBody,
} from '../lib/api-utils.js';
import { saveCommentCounts } from '../lib/comment-counts.js';
import {
  saveLeanHeartbeat,
  saveLeanQueue,
  saveLeanSnapshot,
} from '../lib/d1-optimized-ingest.js';
import { saveQueueReachability } from '../lib/queue-reachability.js';

export * from './ingest-core.js';
export { onRequestGet };

export function isPendingStreamSchemaError(error) {
  const message = String(error?.message || error || '');
  return /no such column:\s*(?:last_stream_count|last_stream_at|validated_stream_count)\b/i.test(message)
    || /table\s+sh_channel_snapshots\s+has no column named\s+validated_stream_count/i.test(message);
}

async function handleComments({ env, body, observedAt, data }) {
  const result = await saveCommentCounts(env.DB, observedAt, data);
  return { ok: true, type: body.type, ...result };
}

async function handleSnapshot({ env, body, observedAt, data }) {
  const result = await saveLeanSnapshot(env.DB, observedAt, data);
  return { ok: true, type: body.type, accepted: true, ...result };
}

async function handleQueue({ env, body, observedAt, data }) {
  const result = await saveLeanQueue(env.DB, observedAt, body);
  const structuralSnapshotWritten = result.structureChanged === true && result.claim.accepted === true;
  const reachability = structuralSnapshotWritten
    ? { inserted: false }
    : await saveQueueReachability(env.DB, observedAt, data);
  return {
    ok: true,
    type: body.type,
    accepted: result.claim.accepted,
    duplicate: result.claim.duplicate || false,
    claim_reason: result.claim.reason || null,
    queue_inspected: result.inspected,
    structure_changed: result.structureChanged === true,
    likes_changed: result.likesChanged === true,
    complete_likes: result.completeLikes !== false,
    queue_items_written: result.itemsWritten,
    like_observations_written: result.observationsWritten,
    reachability_checkpoint_written: reachability.inserted,
    reachability_recorded: structuralSnapshotWritten || reachability.inserted,
  };
}

async function handleCollectorHeartbeat({ env, body, observedAt, data }) {
  const result = await saveLeanHeartbeat(env.DB, observedAt, {
    ...data,
    collector_id: data?.collector_id || body?.collector_id,
  });
  return { ok: true, type: body.type, accepted: result.accepted };
}

const INGEST_HANDLERS = {
  comments: handleComments,
  snapshot: handleSnapshot,
  queue: handleQueue,
  collector_heartbeat: handleCollectorHeartbeat,
};

export function supportsOptimizedIngestType(type) {
  return Object.hasOwn(INGEST_HANDLERS, String(type || ''));
}

export async function ingestOptimizedBody(env, body) {
  if (!env?.DB) return null;
  const handler = INGEST_HANDLERS[body?.type];
  if (!handler) return null;
  const observedAt = observedAtFrom(body);
  const data = body?.data ?? {};
  return handler({ env, body, observedAt, data });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!authorized(request, env) || !env.DB) return corePost(context);

  const parsed = await readJsonBody(request, { clone: true });
  if (!parsed.ok || !supportsOptimizedIngestType(parsed.body?.type)) return corePost(context);

  try {
    const result = await ingestOptimizedBody(env, parsed.body);
    return json(result);
  } catch (error) {
    if (parsed.body?.type === 'snapshot' && isPendingStreamSchemaError(error)) {
      console.warn(JSON.stringify({
        event: 'snapshot_schema_fallback',
        reason: String(error?.message || error),
      }));
      return corePost(context);
    }
    console.error(error);
    return json({ ok: false, error: error?.message || 'database error' }, 500);
  }
}
