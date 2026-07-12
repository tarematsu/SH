import { onRequestPost as corePost, onRequestGet } from './host-ingest-core.js';
import {
  authorized,
  json,
  observedAtFrom,
  readJsonBody,
} from '../lib/api-utils.js';
import { saveSoloActivityCounts } from '../lib/solo-activity-counts.js';

export * from './host-ingest-core.js';
export { onRequestGet };

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!authorized(request, env) || !env.OTHER_DB) return corePost(context);
  const parsed = await readJsonBody(request, { clone: true });
  if (!parsed.ok) return corePost(context);
  const body = parsed.body;
  if (body?.type !== 'solo_comments') return corePost(context);
  try {
    const result = await saveSoloActivityCounts(env.OTHER_DB, observedAtFrom(body), body?.data ?? {});
    return json({ ok: true, type: body.type, accepted: result.accepted, total: result.total });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'database error' }, 500);
  }
}
