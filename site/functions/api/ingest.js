import { onRequestPost as corePost, onRequestGet } from './ingest-core.js';
import { authorized, json, num } from '../lib/api-utils.js';
import { saveCommentCounts } from '../lib/comment-counts.js';
import { runDataMaintenanceSafely } from '../lib/data-maintenance.js';
import {
  saveLeanHeartbeat,
  saveLeanQueue,
  saveLeanSnapshot,
} from '../lib/d1-optimized-ingest.js';

export * from './ingest-core.js';
export { onRequestGet };

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!authorized(request, env) || !env.DB) return corePost(context);

  let body;
  try {
    body = await request.clone().json();
  } catch {
    return corePost(context);
  }

  const observedAt = num(body?.observed_at) ?? Date.now();
  const data = body?.data ?? {};
  try {
    if (body?.type === 'comments') {
      const result = await saveCommentCounts(env.DB, observedAt, data);
      return json({ ok: true, type: body.type, ...result });
    }
    if (body?.type === 'snapshot') {
      const result = await saveLeanSnapshot(env.DB, observedAt, data);
      if (typeof context.waitUntil === 'function') {
        context.waitUntil(runDataMaintenanceSafely(env.DB));
      }
      return json({ ok: true, type: body.type, accepted: true, ...result });
    }
    if (body?.type === 'queue') {
      const result = await saveLeanQueue(env.DB, observedAt, body);
      return json({
        ok: true,
        type: body.type,
        accepted: result.claim.accepted,
        duplicate: result.claim.duplicate || false,
        claim_reason: result.claim.reason || null,
        queue_inspected: result.inspected,
        queue_items_written: result.itemsWritten,
        like_observations_written: result.observationsWritten,
      });
    }
    if (body?.type === 'collector_heartbeat') {
      const result = await saveLeanHeartbeat(env.DB, observedAt, {
        ...data,
        collector_id: data?.collector_id || body?.collector_id,
      });
      return json({ ok: true, type: body.type, accepted: result.accepted });
    }
    return corePost(context);
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'database error' }, 500);
  }
}
