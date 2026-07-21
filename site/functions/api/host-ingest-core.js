import { onRequestPost as legacyPost, onRequestGet } from './host-ingest-legacy.mjs';
import { claimWrite, minuteBucket, sourceIdentity } from '../lib/ingest-claim.js';
import { json, authorized, num, bool, text } from '../lib/api-utils.js';
import { requestWithParsedJson } from '../lib/parsed-request.js';

export { onRequestGet };

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
    num(data.queue_id), num(data.queue_start_time), num(data.comment_velocity),
  ];

  const snapshotStatement = state?.snapshot_id
    ? db.prepare(`UPDATE sh_host_station_snapshots SET
        session_id=?,observed_at=?,source_scope=?,handle=?,account_id=?,station_id=?,
        broadcast_id=?,broadcast_start_time=?,is_broadcasting=?,status=?,chat_status=?,
        listener_count=?,guest_count=?,total_listens=?,channel_id=?,channel_alias=?,
        current_track_id=?,current_spotify_id=?,queue_id=?,queue_start_time=?,
        comment_velocity=COALESCE(?,comment_velocity),raw_json=NULL
      WHERE id=?`).bind(...values, state.snapshot_id)
    : db.prepare(`INSERT INTO sh_host_station_snapshots (
        session_id,observed_at,source_scope,handle,account_id,station_id,
        broadcast_id,broadcast_start_time,is_broadcasting,status,chat_status,
        listener_count,guest_count,total_listens,channel_id,channel_alias,
        current_track_id,current_spotify_id,queue_id,queue_start_time,comment_velocity,raw_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).bind(...values);

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
  const peakRow = await db.prepare(`SELECT MAX(listener_count) AS peak
    FROM sh_host_station_snapshots WHERE session_id=?`).bind(sessionId).first();
  peak = num(peakRow?.peak);
  await sessionAggregateStatement(db, data, observedAt, sessionId, peak, listenerSum, sampleCount).run();
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!authorized(request, env) || !env.DB || !env.OTHER_DB) return legacyPost(context);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }
  if (body?.type !== 'solo_station_snapshot') {
    return legacyPost({ ...context, request: requestWithParsedJson(request, body) });
  }
  const observedAt = num(body?.observed_at) ?? Date.now();
  const data = body?.data ?? {};
  const source = sourceIdentity(body, {
    collectorId: body?.collector_id,
    collectorKind: 'external',
  });
  try {
    const claim = await claimStationSnapshot(env.DB, observedAt, data, source);
    if (claim.accepted) await saveStationSnapshot(env.OTHER_DB, observedAt, data);
    return json({
      ok: true,
      type: body.type,
      accepted: claim.accepted,
      duplicate: claim.duplicate,
      claim_reason: claim.reason,
    });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'database error' }, 500);
  }
}
