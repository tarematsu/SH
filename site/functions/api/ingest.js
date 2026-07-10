import { onRequestPost as corePost, onRequestGet } from './ingest-core.js';
import {
  authorized,
  json,
  observedAtFrom,
  readJsonBody,
  stripAppleMusicFields,
} from '../lib/api-utils.js';
import { saveCommentCounts } from '../lib/comment-counts.js';
import {
  saveLeanHeartbeat,
  saveLeanQueue,
  saveLeanSnapshot,
} from '../lib/d1-optimized-ingest.js';

export * from './ingest-core.js';
export { onRequestGet };

export function isPendingStreamSchemaError(error) {
  const message = String(error?.message || error || '');
  return /no such column:\s*(?:last_stream_count|last_stream_at|validated_stream_count)\b/i.test(message)
    || /table\s+sh_channel_snapshots\s+has no column named\s+validated_stream_count/i.test(message);
}

function spotifyOnlyBody(body) {
  return body?.type === 'queue'
    ? { ...body, data: stripAppleMusicFields(body?.data ?? {}) }
    : body;
}

async function handleComments({ env, body, observedAt, data }) {
  const result = await saveCommentCounts(env.DB, observedAt, data);
  return json({ ok: true, type: body.type, ...result });
}

async function handleSnapshot({ env, body, observedAt, data }) {
  const result = await saveLeanSnapshot(env.DB, observedAt, data);
  return json({ ok: true, type: body.type, accepted: true, ...result });
}

async function handleQueue({ env, body, observedAt }) {
  const result = await saveLeanQueue(env.DB, observedAt, body);
  return json({
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
  });
}

async function handleCollectorHeartbeat({ env, body, observedAt, data }) {
  const result = await saveLeanHeartbeat(env.DB, observedAt, {
    ...data,
    collector_id: data?.collector_id || body?.collector_id,
  });
  return json({ ok: true, type: body.type, accepted: result.accepted });
}

const INGEST_HANDLERS = {
  comments: handleComments,
  snapshot: handleSnapshot,
  queue: handleQueue,
  collector_heartbeat: handleCollectorHeartbeat,
};

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!authorized(request, env) || !env.DB) return corePost(context);

  const parsed = await readJsonBody(request, { clone: true });
  if (!parsed.ok) return corePost(context);
  const body = spotifyOnlyBody(parsed.body);
  const handler = INGEST_HANDLERS[body?.type];
  if (!handler) return corePost(context);

  const observedAt = observedAtFrom(body);
  const data = body?.data ?? {};
  try {
    return await handler({ context, env, body, observedAt, data });
  } catch (error) {
    if (body?.type === 'snapshot' && isPendingStreamSchemaError(error)) {
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
