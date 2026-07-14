import { onRequestPost as corePost, onRequestGet as coreGet } from './ingest-core.js';
import { authorized, json, observedAtFrom, readJsonBody } from '../lib/api-utils.js';
import { saveCommentCounts } from '../lib/comment-counts.js';
import { saveLeanHeartbeat, saveLeanQueue, saveLeanSnapshot } from '../lib/d1-optimized-ingest.js';
import { saveQueueReachability } from '../lib/queue-reachability.js';

export * from './ingest-core.js';

export function isPendingStreamSchemaError(error) {
  const message = String(error?.message || error || '');
  return /no such column:\s*(?:last_stream_count|last_stream_at|validated_stream_count)\b/i.test(message)
    || /table\s+sh_channel_snapshots\s+has no column named\s+validated_stream_count/i.test(message);
}

const INGEST_HANDLERS = {
  comments: async ({ env, body, observedAt, data }) => ({ ok: true, type: body.type, ...await saveCommentCounts(env.DB, observedAt, data) }),
  snapshot: async ({ env, body, observedAt, data }) => ({ ok: true, type: body.type, accepted: true, ...await saveLeanSnapshot(env.DB, observedAt, data) }),
  queue: async ({ env, body, observedAt, data }) => {
    const result = await saveLeanQueue(env.DB, observedAt, body);
    const structuralSnapshotWritten = result.structureChanged === true && result.claim.accepted === true;
    const reachability = structuralSnapshotWritten ? { inserted: false } : await saveQueueReachability(env.DB, observedAt, data);
    return {
      ok: true, type: body.type, accepted: result.claim.accepted, duplicate: result.claim.duplicate || false,
      claim_reason: result.claim.reason || null, queue_inspected: result.inspected,
      structure_changed: result.structureChanged === true, likes_changed: result.likesChanged === true,
      complete_likes: result.completeLikes !== false, queue_items_written: result.itemsWritten,
      like_observations_written: result.observationsWritten,
      reachability_checkpoint_written: reachability.inserted,
      reachability_recorded: structuralSnapshotWritten || reachability.inserted,
    };
  },
  collector_heartbeat: async ({ env, body, observedAt, data }) => {
    const result = await saveLeanHeartbeat(env.DB, observedAt, { ...data, collector_id: data?.collector_id || body?.collector_id });
    return { ok: true, type: body.type, accepted: result.accepted };
  },
};

export function supportsOptimizedIngestType(type) {
  return Object.hasOwn(INGEST_HANDLERS, String(type || ''));
}

export async function ingestOptimizedBody(env, body) {
  if (!env?.DB) return null;
  const handler = INGEST_HANDLERS[body?.type];
  if (!handler) return null;
  return handler({ env, body, observedAt: observedAtFrom(body), data: body?.data ?? {} });
}

// Internal entry point used by the collector Worker. It is deliberately not
// the Pages route export.
export async function ingestInternal(context) {
  const { request, env } = context;
  if (!authorized(request, env) || !env.DB) return corePost(context);
  const parsed = await readJsonBody(request, { clone: true });
  if (!parsed.ok || !supportsOptimizedIngestType(parsed.body?.type)) return corePost(context);
  try {
    return json(await ingestOptimizedBody(env, parsed.body));
  } catch (error) {
    if (parsed.body?.type === 'snapshot' && isPendingStreamSchemaError(error)) return corePost(context);
    console.error(error);
    return json({ ok: false, error: error?.message || 'database error' }, 500);
  }
}

const retired = () => new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
export const onRequestPost = retired;
export const onRequestGet = retired;

// Retained only so worker-side callers can move off the old import without
// duplicating the optimized persistence implementation.
export { coreGet as internalIngestStatus };
