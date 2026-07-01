import { onRequestPost as legacyPost, onRequestGet } from './ingest-legacy.mjs';
import { claimWrite, minuteBucket, payloadHash, sourceIdentity } from '../lib/ingest-claim.js';
import { json, authorized, num, bool, text, rawJson } from '../lib/api-utils.js';

export { onRequestGet };

const QUERY_CHUNK = 80;
const BATCH_CHUNK = 80;
const CHECKPOINT_MS = 60 * 60 * 1000;

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function runBatches(db, statements) {
  for (const group of chunks(statements, BATCH_CHUNK)) {
    if (group.length) await db.batch(group);
  }
}

function queueClaimPayload(data) {
  return {
    station_id: num(data?.station_id),
    queue_id: num(data?.queue_id),
    start_time: num(data?.start_time),
    is_paused: bool(data?.is_paused),
    tracks: (Array.isArray(data?.tracks) ? data.tracks : []).map((track) => ({
      position: num(track.position),
      queue_track_id: num(track.queue_track_id),
      stationhead_track_id: num(track.stationhead_track_id),
      spotify_id: text(track.spotify_id),
      apple_music_id: text(track.apple_music_id),
      deezer_id: text(track.deezer_id),
      isrc: text(track.isrc),
      duration_ms: num(track.duration_ms),
      preview_url: text(track.preview_url),
      bite_count: num(track.bite_count),
    })),
  };
}

function observationTrackKey(track) {
  return text(track?.queue_track_id)
    || text(track?.stationhead_track_id)
    || text(track?.spotify_id)
    || text(track?.isrc)
    || `position:${num(track?.position) ?? -1}`;
}

export function latestLikesSql(count) {
  const placeholders = Array.from({ length: count }, () => '?').join(',');
  return `WITH ranked AS (
    SELECT track_key,observed_at,like_count,
      ROW_NUMBER() OVER (PARTITION BY track_key ORDER BY observed_at DESC,id DESC) AS row_rank
    FROM sh_track_like_observations
    WHERE station_id IS ? AND track_key IN (${placeholders})
  ) SELECT track_key,observed_at,like_count FROM ranked WHERE row_rank=1`;
}

export function planLikeObservations(tracks, latestRows, observedAt) {
  const latest = new Map((latestRows || []).map((row) => [String(row.track_key), row]));
  const unique = new Map();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    if (num(track?.bite_count) == null) continue;
    unique.set(observationTrackKey(track), track);
  }
  return [...unique.entries()]
    .filter(([trackKey, track]) => {
      const previous = latest.get(trackKey);
      return !previous
        || num(previous.like_count) !== num(track.bite_count)
        || observedAt - (num(previous.observed_at) ?? 0) >= CHECKPOINT_MS;
    })
    .map(([trackKey, track]) => ({ trackKey, track }));
}

async function loadLatestLikes(db, stationId, trackKeys) {
  const rows = [];
  for (const group of chunks(trackKeys, QUERY_CHUNK)) {
    if (!group.length) continue;
    const result = await db.prepare(latestLikesSql(group.length)).bind(stationId, ...group).all();
    rows.push(...(result.results || []));
  }
  return rows;
}

function queueItemState(track) {
  return {
    queue_id: num(track.queue_id),
    queue_track_id: num(track.queue_track_id),
    stationhead_track_id: num(track.stationhead_track_id),
    spotify_id: text(track.spotify_id),
    apple_music_id: text(track.apple_music_id),
    deezer_id: text(track.deezer_id),
    isrc: text(track.isrc),
    duration_ms: num(track.duration_ms),
    preview_url: text(track.preview_url),
    bite_count: num(track.bite_count),
    raw_json: rawJson(track.raw),
  };
}

function sameValue(left, right) {
  return (left ?? null) === (right ?? null);
}

export function queueItemsToWrite(tracks, existingRows, observedAt, queueId = null) {
  const existing = new Map((existingRows || []).map((row) => [Number(row.position), row]));
  const unique = new Map();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const position = num(track.position);
    if (position != null) unique.set(position, track);
  }
  return [...unique.values()].filter((track) => {
    const previous = existing.get(num(track.position));
    if (!previous) return true;
    const current = queueItemState({ ...track, queue_id: queueId });
    const changed = Object.entries(current).some(([key, value]) => !sameValue(previous[key], value));
    const checkpointDue = observedAt - (num(previous.observed_at) ?? 0) >= CHECKPOINT_MS;
    return changed || checkpointDue;
  });
}

async function loadExistingQueueItems(db, stationId, startTime, positions) {
  const rows = [];
  for (const group of chunks(positions, QUERY_CHUNK)) {
    if (!group.length) continue;
    const placeholders = group.map(() => '?').join(',');
    const result = await db.prepare(`SELECT
      position,observed_at,queue_id,queue_track_id,stationhead_track_id,
      spotify_id,apple_music_id,deezer_id,isrc,duration_ms,preview_url,bite_count,raw_json
      FROM sh_queue_items
      WHERE station_id IS ? AND start_time IS ? AND position IN (${placeholders})`)
      .bind(stationId, startTime, ...group).all();
    rows.push(...(result.results || []));
  }
  return rows;
}

export const QUEUE_INSPECTION_STATE_SQL = `SELECT snapshots.raw_json,
  (SELECT MAX(items.observed_at) FROM sh_queue_items items
    WHERE items.station_id IS ? AND items.start_time IS ?) AS item_observed_at
FROM sh_queue_snapshots snapshots
WHERE snapshots.station_id IS ? AND snapshots.start_time IS ?
ORDER BY snapshots.observed_at DESC,snapshots.id DESC
LIMIT 1`;

export function queueInspectionDue(previous, payloadJson, observedAt) {
  if (!previous || previous.raw_json !== payloadJson) return true;
  const itemObservedAt = num(previous.item_observed_at);
  return itemObservedAt == null || observedAt - itemObservedAt >= CHECKPOINT_MS;
}

async function saveQueue(db, observedAt, data, payload = queueClaimPayload(data)) {
  const stationId = num(data?.station_id);
  const queueId = num(data?.queue_id);
  const startTime = num(data?.start_time);
  const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
  const bucket = minuteBucket(observedAt);
  const payloadJson = rawJson(payload);
  const previous = await db.prepare(QUEUE_INSPECTION_STATE_SQL)
    .bind(stationId, startTime, stationId, startTime).first();

  await db.prepare(`INSERT INTO sh_queue_snapshots (
      observed_at,station_id,queue_id,start_time,is_paused,raw_json
    ) SELECT ?,?,?,?,?,?
    WHERE NOT EXISTS (
      SELECT 1 FROM sh_queue_snapshots
      WHERE station_id IS ? AND start_time IS ? AND observed_at>=? AND observed_at<?
    )`).bind(
    observedAt, stationId, queueId, startTime, bool(data?.is_paused), payloadJson,
    stationId, startTime, bucket, bucket + 60000,
  ).run();

  if (!queueInspectionDue(previous, payloadJson, observedAt)) return;

  const positions = [...new Set(tracks.map((track) => num(track.position)).filter((value) => value != null))];
  const existingRows = await loadExistingQueueItems(db, stationId, startTime, positions);
  const changedTracks = queueItemsToWrite(tracks, existingRows, observedAt, queueId);
  const statements = changedTracks.map((track) => db.prepare(`INSERT INTO sh_queue_items (
      observed_at,station_id,queue_id,start_time,position,
      queue_track_id,stationhead_track_id,spotify_id,apple_music_id,
      deezer_id,isrc,duration_ms,preview_url,bite_count,raw_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(station_id,start_time,position) DO UPDATE SET
      observed_at=excluded.observed_at,queue_id=excluded.queue_id,
      queue_track_id=excluded.queue_track_id,stationhead_track_id=excluded.stationhead_track_id,
      spotify_id=excluded.spotify_id,apple_music_id=excluded.apple_music_id,
      deezer_id=excluded.deezer_id,isrc=excluded.isrc,duration_ms=excluded.duration_ms,
      preview_url=excluded.preview_url,bite_count=excluded.bite_count,raw_json=excluded.raw_json`)
    .bind(
      observedAt, stationId, queueId, startTime, num(track.position),
      num(track.queue_track_id), num(track.stationhead_track_id),
      text(track.spotify_id), text(track.apple_music_id), text(track.deezer_id),
      text(track.isrc), num(track.duration_ms), text(track.preview_url),
      num(track.bite_count), rawJson(track.raw),
    ));
  await runBatches(db, statements);

  const keyed = [...new Set(
    tracks.filter((track) => num(track?.bite_count) != null).map(observationTrackKey),
  )];
  if (!keyed.length) return;
  const latestRows = await loadLatestLikes(db, stationId, keyed);
  const observations = planLikeObservations(tracks, latestRows, observedAt);
  await runBatches(db, observations.map(({ trackKey, track }) => db.prepare(`INSERT OR IGNORE INTO sh_track_like_observations (
      observed_at,station_id,queue_id,start_time,position,
      queue_track_id,stationhead_track_id,spotify_id,apple_music_id,isrc,
      track_key,like_count,source,raw_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    observedAt, stationId, queueId, startTime, num(track.position),
    num(track.queue_track_id), num(track.stationhead_track_id),
    text(track.spotify_id), text(track.apple_music_id), text(track.isrc),
    trackKey, num(track.bite_count), 'collector', rawJson(track.raw ?? track),
  )));
}

async function loadExistingComments(db, ids) {
  const rows = [];
  for (const group of chunks(ids, QUERY_CHUNK)) {
    if (!group.length) continue;
    const placeholders = group.map(() => '?').join(',');
    const result = await db.prepare(`SELECT id,raw_json FROM sh_comments WHERE id IN (${placeholders})`)
      .bind(...group).all();
    rows.push(...(result.results || []));
  }
  return rows;
}

export function commentsToWrite(comments, existingRows) {
  const existing = new Map((existingRows || []).map((row) => [Number(row.id), row.raw_json]));
  const unique = new Map();
  for (const comment of Array.isArray(comments) ? comments : []) {
    const id = num(comment.id);
    if (id != null) unique.set(id, comment);
  }
  return [...unique.values()].filter((comment) => {
    const id = num(comment.id);
    return !existing.has(id) || existing.get(id) !== rawJson(comment.raw);
  });
}

async function saveComments(db, observedAt, data) {
  const comments = Array.isArray(data?.comments) ? data.comments : [];
  const ids = [...new Set(comments.map((comment) => num(comment.id)).filter((value) => value != null))];
  const existingRows = await loadExistingComments(db, ids);
  const changed = commentsToWrite(comments, existingRows);

  await runBatches(db, changed.map((comment) => db.prepare(`INSERT INTO sh_comments (
      id,observed_at,station_id,account_id,handle,text,text_with_xml,
      chat_time,chat_time_ms,all_access_chat,boost_chat,
      active_stream_days,followers,following,emoji,raw_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      station_id=excluded.station_id,account_id=excluded.account_id,
      handle=excluded.handle,text=excluded.text,text_with_xml=excluded.text_with_xml,
      chat_time=excluded.chat_time,chat_time_ms=excluded.chat_time_ms,
      all_access_chat=excluded.all_access_chat,boost_chat=excluded.boost_chat,
      active_stream_days=excluded.active_stream_days,
      followers=excluded.followers,following=excluded.following,
      emoji=excluded.emoji,raw_json=excluded.raw_json`)
    .bind(
      num(comment.id), observedAt, num(comment.station_id), num(comment.account_id),
      text(comment.handle), text(comment.text), text(comment.text_with_xml),
      num(comment.chat_time), num(comment.chat_time_ms),
      bool(comment.all_access_chat), bool(comment.boost_chat),
      num(comment.active_stream_days), num(comment.followers), num(comment.following),
      text(comment.emoji), rawJson(comment.raw),
    )));

  const stationId = num(data?.station_id ?? comments.find((comment) => num(comment.station_id) != null)?.station_id);
  if (stationId == null) return;
  const velocityRow = await db.prepare(`SELECT COUNT(*) AS count FROM sh_comments
    WHERE station_id=?
      AND COALESCE(chat_time_ms,chat_time*1000,observed_at)>?
      AND COALESCE(chat_time_ms,chat_time*1000,observed_at)<=?`)
    .bind(stationId, observedAt - 120000, observedAt).first();
  const velocity = num(velocityRow?.count) ?? 0;
  await db.prepare(`UPDATE sh_channel_snapshots SET comment_velocity=?
    WHERE id=(SELECT id FROM sh_channel_snapshots
      WHERE station_id=? AND observed_at<=?
      ORDER BY observed_at DESC,id DESC LIMIT 1)`)
    .bind(velocity, stationId, observedAt).run();
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!authorized(request, env) || !env.DB) return legacyPost(context);
  let body;
  try { body = await request.clone().json(); } catch { return legacyPost(context); }
  const type = body?.type;
  if (!['queue', 'comments'].includes(type)) return legacyPost(context);
  const observedAt = num(body?.observed_at) ?? Date.now();
  const data = body?.data ?? {};

  try {
    if (type === 'comments') {
      await saveComments(env.DB, observedAt, data);
      return json({ ok: true, type, accepted: true });
    }

    const source = sourceIdentity(body, {
      collectorId: body?.collector_id,
      collectorKind: 'external',
      sourcePriority: 50,
    });
    const payload = queueClaimPayload(data);
    const hash = await payloadHash(payload);
    const claim = await claimWrite(env.DB, {
      dedupeKey: `station:${num(data.station_id) ?? 0}:queue:${num(data.start_time) ?? 0}:minute:${minuteBucket(observedAt)}:hash:${hash}`,
      dataType: type,
      ...source,
      observedAt,
      hash,
      payload,
      metadata: { station_id: num(data.station_id), start_time: num(data.start_time) },
    });
    if (claim.accepted) await saveQueue(env.DB, observedAt, data, payload);
    return json({
      ok: true,
      type,
      accepted: claim.accepted,
      duplicate: claim.duplicate || false,
      claim_reason: claim.reason || null,
    });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'database error' }, 500);
  }
}
