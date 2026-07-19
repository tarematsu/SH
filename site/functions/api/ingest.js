import { onRequestPost as corePost, onRequestGet as coreGet } from './ingest-core.js';
import {
  authorized,
  json,
  num,
  observedAtFrom,
  rawJson,
  readJsonBody,
  stripAppleMusicFields,
  text,
} from '../lib/api-utils.js';
import { withAppleMusicFreeD1 } from '../lib/apple-music-d1-pruner.js';
import { saveCommentCounts } from '../lib/comment-counts.js';
import { saveLeanHeartbeat, saveLeanQueue, saveLeanSnapshot } from '../lib/d1-optimized-ingest.js';
import { requestWithParsedJson } from '../lib/parsed-request.js';
import { saveQueueReachability } from '../lib/queue-reachability.js';

export * from './ingest-core.js';

export function isPendingStreamSchemaError(error) {
  const message = String(error?.message || error || '');
  return /no such column:\s*(?:last_stream_count|last_stream_at|validated_stream_count)\b/i.test(message)
    || /table\s+sh_channel_snapshots\s+has no column named\s+validated_stream_count/i.test(message);
}

const INGEST_HANDLERS = {
  comments: async (env, body, observedAt, data) => ({ ok: true, type: body.type, ...await saveCommentCounts(env.DB, observedAt, data) }),
  snapshot: async (env, body, observedAt, data) => ({ ok: true, type: body.type, accepted: true, ...await saveLeanSnapshot(env.DB, observedAt, data) }),
  queue: async (env, body, observedAt, data) => {
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
  collector_heartbeat: async (env, body, observedAt, data) => {
    const result = await saveLeanHeartbeat(env.DB, observedAt, { ...data, collector_id: data?.collector_id || body?.collector_id });
    return { ok: true, type: body.type, accepted: result.accepted };
  },
  track_metadata: async (env, body, observedAt, data) => {
    const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
    const statements = tracks.filter((track) => track?.spotify_id).map((track) => env.DB.prepare(`INSERT INTO sh_track_metadata (
        spotify_id,isrc,title,artist,display_title,thumbnail_url,
        spotify_url,source,fetched_at,raw_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(spotify_id) DO UPDATE SET
        isrc=COALESCE(excluded.isrc,sh_track_metadata.isrc),
        title=COALESCE(excluded.title,sh_track_metadata.title),
        artist=COALESCE(excluded.artist,sh_track_metadata.artist),
        display_title=COALESCE(excluded.display_title,sh_track_metadata.display_title),
        thumbnail_url=COALESCE(excluded.thumbnail_url,sh_track_metadata.thumbnail_url),
        spotify_url=COALESCE(excluded.spotify_url,sh_track_metadata.spotify_url),
        source=excluded.source,
        fetched_at=MAX(excluded.fetched_at,sh_track_metadata.fetched_at),
        raw_json=COALESCE(excluded.raw_json,sh_track_metadata.raw_json)`)
      .bind(
        text(track.spotify_id), text(track.isrc)?.trim().toUpperCase() || null,
        text(track.title), text(track.artist), text(track.display_title), text(track.thumbnail_url),
        text(track.spotify_url), text(track.source || 'spotify_oembed'), num(track.fetched_at) ?? observedAt,
        rawJson(track.raw),
      ));
    if (statements.length) await env.DB.batch(statements);
    return { ok: true, type: body.type, accepted: true, tracks_written: statements.length };
  },
};
const NO_OPTIMIZED_INGEST = Promise.resolve(null);

export function supportsOptimizedIngestType(type) {
  return Object.hasOwn(INGEST_HANDLERS, String(type || ''));
}

export function ingestOptimizedBody(env, body) {
  if (!env?.DB) return NO_OPTIMIZED_INGEST;
  const activeEnv = withAppleMusicFreeD1(env);
  const handler = INGEST_HANDLERS[body?.type];
  if (!handler) return NO_OPTIMIZED_INGEST;
  return handler(activeEnv, body, observedAtFrom(body), body?.data ?? {});
}

// Internal entry point used by the collector Worker. It is deliberately not
// the Pages route export.
export async function ingestInternal(context) {
  const { request, env } = context;
  if (!authorized(request, env) || !env.DB) return corePost(context);
  const parsed = await readJsonBody(request, { clone: true });
  if (!parsed.ok) return corePost(context);
  const body = stripAppleMusicFields(parsed.body);
  const fallbackContext = {
    ...context,
    request: requestWithParsedJson(request, body),
  };
  if (!supportsOptimizedIngestType(body?.type)) return corePost(fallbackContext);
  try {
    return json(await ingestOptimizedBody(env, body));
  } catch (error) {
    if (body?.type === 'snapshot' && isPendingStreamSchemaError(error)) return corePost(fallbackContext);
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
