import { onRequestPost as corePost } from './host-ingest-core.js';
import { authorized, json, observedAtFrom, readJsonBody } from '../lib/api-utils.js';
import { saveSoloActivityCounts } from '../lib/solo-activity-counts.js';

export * from './host-ingest-core.js';

// Internal entry point for the other Worker. Pages exports a closed route.
export async function hostIngestInternal(context) {
  const { request, env } = context;
  if (!authorized(request, env) || !env.OTHER_DB) return corePost(context);
  const parsed = await readJsonBody(request, { clone: true });
  if (!parsed.ok || parsed.body?.type !== 'solo_comments') return corePost(context);
  try {
    const result = await saveSoloActivityCounts(env.OTHER_DB, observedAtFrom(parsed.body), parsed.body?.data ?? {});
    return json({ ok: true, type: parsed.body.type, accepted: result.accepted, total: result.total });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'database error' }, 500);
  }
}

const retired = () => new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
export const onRequestPost = retired;
