import { onRequestPost as corePost, onRequestGet } from './host-ingest-core.js';
import { authorized, json, num } from '../lib/api-utils.js';
import { saveSoloActivityCounts } from '../lib/solo-activity-counts.js';

export * from './host-ingest-core.js';
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
  if (body?.type !== 'solo_comments') return corePost(context);
  try {
    const result = await saveSoloActivityCounts(env.DB, num(body?.observed_at) ?? Date.now(), body?.data ?? {});
    return json({ ok: true, type: body.type, accepted: result.accepted, total: result.total });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'database error' }, 500);
  }
}
