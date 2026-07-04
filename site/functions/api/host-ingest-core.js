import { onRequestPost as legacyPost, onRequestGet } from './host-ingest-legacy.mjs';
import { claimWrite, minuteBucket, payloadHash, sourceIdentity } from '../lib/ingest-claim.js';
import { json, authorized, num, bool, text, rawJson } from '../lib/api-utils.js';
import { requestWithParsedJson } from '../lib/parsed-request.js';

export { onRequestGet };

const QUERY_CHUNK = 80;
const BATCH_CHUNK = 80;
const IMPORTANT_EVENTS = new Set([
  'listenerCount', 'comment', 'chat', 'trackChanged', 'currentTrack',
  'queueChanged', 'queueUpdate', 'broadcastStarted', 'broadcastEnded',
  'stationStarted', 'stationEnded', 'statusChanged',
]);

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

function stationClaimPayload(data) {
  return {
    session_id: num(data.session_id),
    station_id: num(data.station_id),
    broadcast_id: num(data.broadcast_id),
    is_broadcasting: bool(data.is_broadcasting),
    status: text(data.status),
    chat_status: text(data.chat_status),
    listener_count: num(data.listener_count),
    guest_count: num(data.guest_count),
    total_listens: num(data.total_listens),
    channel_id: num(data.channel_id),
    channel_alias: text(data.channel_alias),
    current_track_id: num(data.current_track_id),
    current_spotify_id: text(data.current_spotify_id),
    queue_id: num(data.queue_id),
    queue_start_time: num(data.queue_start_time),
  };
}

function stationRawPayload(data) {
  return {
    ...stationClaimPayload(data),
    raw_status: text(data.raw?.status),
    owner: {
      handle: text(data.raw?.owner?.handle),
      thumbnail_url: text(data.raw?.owner?.thumbnail?.url),
      medium_url: text(data.raw?.owner?.medium?.url),
    },
    channel: {
      id: num(data.raw?.channel?.id),
      alias: text(data.raw?.channel?.alias),
    },
  };
}

export function listenerAggregateDelta(oldListener, newListener) {
  const before = num(oldListener);
  const after = num(newListener);
  return {
    sum: (after ?? 0) - (before ?? 0),
    count: (after == null ? 0 : 1) - (before == null ? 0 : 1),
  };
}

async function claimStationSnapshot(db, observedAt, data, source) {
  return claimWrite(db, {
    dedupeKey: `solo:${num(data.session_id) ?? 0}:minute:${minuteBucket(observedAt)}`,
    dataType: 'solo_station_snapshot',
    ...source,
    observedAt,
    payload: stationClaimPayload(data),
  });
}

function sessionAggregateStatement(db, data, observedAt, sessionId, peak, listenerSum, sampleCount) {
  return db.prepare(`UPDATE sh_host_broadcast_sessions SET
      account_id=COALESCE(?,account_id),broadcast_id=COALESCE(?,broadcast_id),
      peak_listeners=?,listener_sum=?,listener_sample_count=?,average_listeners=?,
      total_listens_end=COALESCE(?,total_listens_end),last_observed_at=?
    WHERE id=?`).bind(
    num(data.account_id), num(data.broadcast_id), peak, listenerSum, sampleCount,
    sampleCount ? listenerSum / sampleCount : null,
    num(data.total_listens), observedAt, sessionId,
  );
}

export async function saveStationSnapshot(db, observedAt, data) {
  const sessionId = num(data.session_id);
  const bucket = minuteBucket(observedAt);
  const state = await db.prepare(`SELECT
      sessions.listener_sum,sessions.listener_sample_count,sessions.peak_listeners,
      snapshots.id AS snapshot_id,snapshots.listener_count AS old_listener
    FROM sh_host_broadcast_sessions sessions
    LEFT JOIN sh_host_station_snapshots snapshots ON snapshots.id=(
      SELECT id FROM sh_host_station_snapshots
      WHERE session_id=sessions.id AND observed_at>=? AND observed_at<?
      ORDER BY observed_at DESC,id DESC LIMIT 1
    )
    WHERE sessions.id=?`).bind(bucket, bucket + 60000, sessionId).first();

  const values = [
    sessionId, observedAt, text(data.source_scope), text(data.handle), num(data.account_id),
    num(data.station_id), num(data.broadcast_id), num(data.broadcast_start_time), bool(data.is_broadcasting),
    text(data.status), text(data.chat_status), num(data.listener_count), num(data.guest_count), num(data.total_listens),
    num(data.channel_id), text(data.channel_alias), num(data.current_track_id), text(data.current_spotify_id),
    num(data.queue_id), num(data.queue_start_time), num(data.comment_velocity), rawJson(stationRawPayload(data)),
  ];

  const snapshotStatement = state?.snapshot_id
    ? db.prepare(`UPDATE sh_host_station_snapshots SET
        session_id=?,observed_at=?,source_scope=?,handle=?,account_id=?,station_id=?,
        broadcast_id=?,broadcast_start_time=?,is_broadcasting=?,status=?,chat_status=?,
        listener_count=?,guest_count=?,total_listens=?,channel_id=?,channel_alias=?,
        current_track_id=?,current_spotify_id=?,queue_id=?,queue_start_time=?,
        comment_velocity=COALESCE(?,comment_velocity),raw_json=?
      WHERE id=?`).bind(...values, state.snapshot_id)
    : db.prepare(`INSERT INTO sh_host_station_snapshots (
        session_id,observed_at,source_scope,handle,account_id,station_id,
        broadcast_id,broadcast_start_time,is_broadcasting,status,chat_status,
        listener_count,guest_count,total_listens,channel_id,channel_alias,
        current_track_id,current_spotify_id,queue_id,queue_start_time,comment_velocity,raw_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...values);

  if (!state) {
    await snapshotStatement.run();
    return;
  }

  const delta = listenerAggregateDelta(state.old_listener, data.listener_count);
  const listenerSum = Math.max(0, (num(state.listener_sum) ?? 0) + delta.sum);
  const sampleCount = Math.max(0, (num(state.listener_sample_count) ?? 0) + delta.count);
  const listener = num(data.listener_count);
  let peak = Math.max(num(state.peak_listeners) ?? 0, listener ?? 0) || null;
  const correction = num(state.old_listener) != null
    && num(state.old_listener) >= (num(state.peak_listeners) ?? 0)
    && (listener == null || listener < num(state.old_listener));

  if (!correction) {
    await db.batch([
      snapshotStatement,
      sessionAggregateStatement(db, data, observedAt, sessionId, peak, listenerSum, sampleCount),
    ]);
    return;
  }

  await snapshotStatement.run();
  const peakRow = await db.prepare(`SELECT MAX(value) AS peak FROM (
      SELECT MAX(listener_count) AS value FROM sh_host_station_snapshots WHERE session_id=?
      UNION ALL
      SELECT MAX(CAST(COALESCE(
        json_extract(data_json,'$.listener_count'),json_extract(data_json,'$.count')
      ) AS INTEGER)) AS value
      FROM sh_host_raw_events
      WHERE session_id=? AND event='listenerCount' AND json_valid(data_json)
    )`).bind(sessionId, sessionId).first();
  peak = num(peakRow?.peak);
  await sessionAggregateStatement(db, data, observedAt, sessionId, peak, listenerSum, sampleCount).run();
}

async function loadExistingComments(db, sessionId, ids) {
  const rows = [];
  for (const group of chunks(ids, QUERY_CHUNK)) {
    if (!group.length) continue;
    const placeholders = group.map(() => '?').join(',');
    const result = await db.prepare(`SELECT comment_id,raw_json
      FROM sh_host_comments
      WHERE session_id=? AND comment_id IN (${placeholders})`)
      .bind(sessionId, ...group).all();
    rows.push(...(result.results || []));
  }
  return rows;
}

export function hostCommentsToWrite(comments, existingRows) {
  const existing = new Map((existingRows || []).map((row) => [Number(row.comment_id), row.raw_json]));
  const unique = new Map();
  for (const comment of Array.isArray(comments) ? comments : []) {
    const id = num(comment.comment_id);
    if (id != null) unique.set(id, comment);
  }
  return [...unique.values()].filter((comment) => {
    const id = num(comment.comment_id);
    return !existing.has(id) || existing.get(id) !== rawJson(comment.raw);
  });
}

async function saveComments(db, observedAt, data) {
  const sessionId = num(data.session_id);
  const comments = Array.isArray(data.comments) ? data.comments : [];
  const ids = [...new Set(comments.map((comment) => num(comment.comment_id)).filter((value) => value != null))];
  if (sessionId == null || !ids.length) return;

  const existingRows = await loadExistingComments(db, sessionId, ids);
  const existingIds = new Set(existingRows.map((row) => Number(row.comment_id)));
  const changed = hostCommentsToWrite(comments, existingRows);
  const newCount = ids.reduce((count, id) => count + (existingIds.has(id) ? 0 : 1), 0);

  const statements = changed.map((comment) => db.prepare(`INSERT INTO sh_host_comments (
      session_id,comment_id,observed_at,station_id,account_id,handle,
      text,text_with_xml,chat_time,chat_time_ms,all_access_chat,
      boost_chat,followers,following,active_stream_days,emoji,raw_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_id,comment_id) DO UPDATE SET
      station_id=excluded.station_id,account_id=excluded.account_id,handle=excluded.handle,
      text=excluded.text,text_with_xml=excluded.text_with_xml,
      chat_time=excluded.chat_time,chat_time_ms=excluded.chat_time_ms,
      all_access_chat=excluded.all_access_chat,boost_chat=excluded.boost_chat,
      followers=excluded.followers,following=excluded.following,
      active_stream_days=excluded.active_stream_days,emoji=excluded.emoji,raw_json=excluded.raw_json`)
    .bind(
      sessionId, num(comment.comment_id), observedAt, num(comment.station_id),
      num(comment.account_id), text(comment.handle), text(comment.text), text(comment.text_with_xml),
      num(comment.chat_time), num(comment.chat_time_ms), bool(comment.all_access_chat),
      bool(comment.boost_chat), num(comment.followers), num(comment.following),
      num(comment.active_stream_days), text(comment.emoji), rawJson(comment.raw),
    ));
  if (newCount) {
    statements.push(db.prepare(`UPDATE sh_host_broadcast_sessions
      SET comment_count=COALESCE(comment_count,0)+? WHERE id=?`).bind(newCount, sessionId));
  }
  await runBatches(db, statements);

  const velocityRow = await db.prepare(`SELECT COUNT(*) AS count FROM sh_host_comments
    WHERE session_id=?
      AND COALESCE(chat_time_ms,chat_time*1000,observed_at)>?
      AND COALESCE(chat_time_ms,chat_time*1000,observed_at)<=?`)
    .bind(sessionId, observedAt - 120000, observedAt).first();
  const velocity = num(velocityRow?.count) ?? 0;
  const latestCommentId = Math.max(...ids);
  const update = db.prepare(`UPDATE sh_host_station_snapshots SET comment_velocity=?
    WHERE id=(SELECT id FROM sh_host_station_snapshots
      WHERE session_id=? AND observed_at<=?
      ORDER BY observed_at DESC,id DESC LIMIT 1)`)
    .bind(velocity, sessionId, observedAt);
  try {
    await db.batch([
      update,
      db.prepare(`INSERT OR REPLACE INTO sh_comment_velocity_samples (
          source_scope,station_id,session_id,observed_at,comment_velocity,latest_comment_id
        ) VALUES ('solo',?,?,?,?,?)`)
        .bind(num(data.station_id) || 0, sessionId, observedAt, velocity, latestCommentId),
    ]);
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || ''))) throw error;
    await update.run();
  }
}

async function saveWsEvent(db, observedAt, data) {
  const eventName = text(data.event) || '';
  if (!IMPORTANT_EVENTS.has(eventName)) return false;
  const compactData = data.data && typeof data.data === 'object' ? data.data : null;
  await db.prepare(`INSERT INTO sh_host_raw_events (
      session_id,observed_at,station_id,channel,event,data_json,raw_json
    ) VALUES (?,?,?,?,?,?,NULL)`)
    .bind(
      num(data.session_id), observedAt, num(data.station_id), text(data.channel),
      eventName, rawJson(compactData),
    ).run();
  return true;
}

async function claimWsEvent(db, observedAt, data, source) {
  const hash = await payloadHash({ event: data.event, channel: data.channel, data: data.data });
  return claimWrite(db, {
    dedupeKey: `solo:${num(data.session_id) ?? 0}:ws:${Math.floor(observedAt / 5000) * 5000}:${hash}`,
    dataType: 'solo_ws_event',
    ...source,
    observedAt,
    payload: data,
    hash,
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!authorized(request, env) || !env.DB) return legacyPost(context);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }
  const type = body?.type;
  if (!['solo_station_snapshot', 'solo_comments', 'solo_ws_event'].includes(type)) {
    return legacyPost({ ...context, request: requestWithParsedJson(request, body) });
  }
  const observedAt = num(body?.observed_at) ?? Date.now();
  const data = body?.data ?? {};
  const source = sourceIdentity(body, {
    collectorId: body?.collector_id,
    collectorKind: 'external',
  });

  try {
    if (type === 'solo_station_snapshot') {
      const claim = await claimStationSnapshot(env.DB, observedAt, data, source);
      if (claim.accepted) await saveStationSnapshot(env.DB, observedAt, data);
      return json({
        ok: true,
        type,
        accepted: claim.accepted,
        duplicate: claim.duplicate,
        claim_reason: claim.reason,
      });
    }
    if (type === 'solo_comments') {
      await saveComments(env.DB, observedAt, data);
      return json({ ok: true, type, accepted: true });
    }
    const claim = await claimWsEvent(env.DB, observedAt, data, source);
    if (!claim.accepted) {
      return json({
        ok: true,
        type,
        accepted: false,
        duplicate: claim.duplicate,
        claim_reason: claim.reason,
      });
    }
    const stored = await saveWsEvent(env.DB, observedAt, data);
    return json({ ok: true, type, accepted: true, stored });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'database error' }, 500);
  }
}
