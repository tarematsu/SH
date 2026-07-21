import { claimWrite, minuteBucket, payloadHash, sourceIdentity } from '../lib/ingest-claim.js';
import { json, authorized, num, bool, text } from '../lib/api-utils.js';

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

function queueClaimPayload(data) {
  return {
    session_id: num(data.session_id),
    station_id: num(data.station_id),
    queue_id: num(data.queue_id),
    start_time: num(data.start_time),
    is_paused: bool(data.is_paused),
    current_track_id: num(data.current_track_id),
    current_spotify_id: text(data.current_spotify_id),
    tracks: (Array.isArray(data.tracks) ? data.tracks : []).map((track) => ({
      position: num(track.position),
      queue_track_id: num(track.queue_track_id),
      stationhead_track_id: num(track.stationhead_track_id),
      spotify_id: text(track.spotify_id),
      deezer_id: text(track.deezer_id),
      isrc: text(track.isrc),
      duration_ms: num(track.duration_ms),
    })),
  };
}

async function updateSessionProfile(db, data) {
  const sessionId = num(data.session_id);
  if (sessionId == null) throw new Error('session-scoped profile requires session_id');
  await db.prepare(`UPDATE sh_host_broadcast_sessions SET
      account_id=COALESCE(account_id,?),
      followers_start=COALESCE(followers_start,?),
      total_streams_start=COALESCE(total_streams_start,?)
    WHERE id=?`)
    .bind(num(data.account_id), num(data.followers), num(data.total_streams), sessionId)
    .run();
}

async function openSession(db, observedAt, data) {
  const startedAt = num(data.started_at) ?? observedAt;
  await db.prepare(`INSERT INTO sh_host_broadcast_sessions (
      source_scope,handle,account_id,station_id,broadcast_id,broadcast_stream_id,
      started_at,confirmed_at,ended_at,status,detection_reason,end_reason,
      buddies_station_id,channel_id,channel_alias,total_listens_start,total_listens_end,
      followers_start,followers_end,total_streams_start,total_streams_end,
      peak_listeners,listener_sum,listener_sample_count,average_listeners,
      track_count,comment_count,last_observed_at
    ) VALUES (?,?,?,?,?,?,?,NULL,NULL,'provisional',?,NULL,?,?,?, ?,NULL,?,NULL,?,NULL,NULL,0,0,NULL,0,0,?)
    ON CONFLICT(source_scope,handle,station_id,started_at) DO UPDATE SET
      account_id=COALESCE(excluded.account_id,sh_host_broadcast_sessions.account_id),
      broadcast_id=COALESCE(excluded.broadcast_id,sh_host_broadcast_sessions.broadcast_id),
      broadcast_stream_id=COALESCE(excluded.broadcast_stream_id,sh_host_broadcast_sessions.broadcast_stream_id),
      detection_reason=excluded.detection_reason,
      buddies_station_id=excluded.buddies_station_id,
      channel_id=excluded.channel_id,
      channel_alias=excluded.channel_alias,
      last_observed_at=excluded.last_observed_at`)
    .bind(
      text(data.source_scope) || 'sakurazaka46jp_solo', text(data.handle), num(data.account_id),
      num(data.station_id), num(data.broadcast_id), text(data.broadcast_stream_id), startedAt,
      text(data.detection_reason), num(data.buddies_station_id), num(data.channel_id), text(data.channel_alias),
      num(data.total_listens_start), num(data.followers_start), num(data.total_streams_start), observedAt,
    ).run();

  return db.prepare(`SELECT id FROM sh_host_broadcast_sessions
    WHERE source_scope=? AND handle=? AND station_id=? AND started_at=? LIMIT 1`)
    .bind(text(data.source_scope) || 'sakurazaka46jp_solo', text(data.handle), num(data.station_id), startedAt)
    .first();
}

async function confirmSession(db, observedAt, data) {
  await db.prepare(`UPDATE sh_host_broadcast_sessions
    SET status='active',confirmed_at=COALESCE(confirmed_at,?),last_observed_at=? WHERE id=?`)
    .bind(num(data.confirmed_at) ?? observedAt, observedAt, num(data.session_id)).run();
}

async function recalculateSessionListeners(db, sessionId, observedAt, data) {
  const aggregates = await db.prepare(`SELECT
      MAX(listener_count) AS peak,
      SUM(CASE WHEN listener_count IS NULL THEN 0 ELSE listener_count END) AS listener_sum,
      SUM(CASE WHEN listener_count IS NULL THEN 0 ELSE 1 END) AS sample_count,
      AVG(listener_count) AS average_listeners
    FROM sh_host_station_snapshots WHERE session_id=?`)
    .bind(sessionId).first();

  await db.prepare(`UPDATE sh_host_broadcast_sessions SET
      account_id=COALESCE(?,account_id),broadcast_id=COALESCE(?,broadcast_id),
      peak_listeners=?,listener_sum=?,listener_sample_count=?,average_listeners=?,
      total_listens_end=COALESCE(?,total_listens_end),last_observed_at=?
    WHERE id=?`)
    .bind(
      num(data.account_id), num(data.broadcast_id), num(aggregates?.peak),
      num(aggregates?.listener_sum) ?? 0, num(aggregates?.sample_count) ?? 0,
      num(aggregates?.average_listeners), num(data.total_listens), observedAt, sessionId,
    ).run();
}

async function saveStationSnapshot(db, observedAt, data) {
  const sessionId = num(data.session_id);
  const bucket = minuteBucket(observedAt);
  const values = [
    sessionId, observedAt, text(data.source_scope), text(data.handle), num(data.account_id),
    num(data.station_id), num(data.broadcast_id), num(data.broadcast_start_time), bool(data.is_broadcasting),
    text(data.status), text(data.chat_status), num(data.listener_count), num(data.guest_count), num(data.total_listens),
    num(data.channel_id), text(data.channel_alias), num(data.current_track_id), text(data.current_spotify_id),
    num(data.queue_id), num(data.queue_start_time), num(data.comment_velocity),
  ];

  const updated = await db.prepare(`UPDATE sh_host_station_snapshots SET
      session_id=?,observed_at=?,source_scope=?,handle=?,account_id=?,station_id=?,
      broadcast_id=?,broadcast_start_time=?,is_broadcasting=?,status=?,chat_status=?,
      listener_count=?,guest_count=?,total_listens=?,channel_id=?,channel_alias=?,
      current_track_id=?,current_spotify_id=?,queue_id=?,queue_start_time=?,
      comment_velocity=COALESCE(?,comment_velocity),raw_json=NULL
    WHERE id=(SELECT id FROM sh_host_station_snapshots
      WHERE session_id=? AND observed_at>=? AND observed_at<?
      ORDER BY observed_at DESC,id DESC LIMIT 1)`)
    .bind(...values, sessionId, bucket, bucket + 60000).run();

  if (Number(updated?.meta?.changes || 0) === 0) {
    await db.prepare(`INSERT INTO sh_host_station_snapshots (
        session_id,observed_at,source_scope,handle,account_id,station_id,
        broadcast_id,broadcast_start_time,is_broadcasting,status,chat_status,
        listener_count,guest_count,total_listens,channel_id,channel_alias,
        current_track_id,current_spotify_id,queue_id,queue_start_time,comment_velocity,raw_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`)
      .bind(...values).run();
  }
  await recalculateSessionListeners(db, sessionId, observedAt, data);
}

async function saveQueue(db, observedAt, data) {
  const sessionId = num(data.session_id);
  const tracks = Array.isArray(data.tracks) ? data.tracks : [];
  await db.prepare(`INSERT INTO sh_host_queue_snapshots (
      session_id,observed_at,station_id,queue_id,queue_start_time,is_paused,
      queue_hash,current_track_id,current_spotify_id,raw_json
    ) VALUES (?,?,?,?,?,?,?,?,?,NULL)`)
    .bind(
      sessionId, observedAt, num(data.station_id), num(data.queue_id), num(data.start_time),
      bool(data.is_paused), text(data.queue_hash), num(data.current_track_id), text(data.current_spotify_id),
    ).run();

  if (tracks.length) {
    await db.batch(tracks.map((track) => db.prepare(`INSERT INTO sh_host_queue_items (
        session_id,observed_at,station_id,queue_id,queue_start_time,position,
        queue_track_id,stationhead_track_id,spotify_id,deezer_id,isrc,
        duration_ms,preview_url,bite_count,raw_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
      ON CONFLICT(session_id,queue_start_time,position) DO UPDATE SET
        observed_at=excluded.observed_at,queue_id=excluded.queue_id,
        queue_track_id=excluded.queue_track_id,stationhead_track_id=excluded.stationhead_track_id,
        spotify_id=excluded.spotify_id,deezer_id=excluded.deezer_id,isrc=excluded.isrc,
        duration_ms=excluded.duration_ms,preview_url=excluded.preview_url,
        bite_count=excluded.bite_count,raw_json=NULL`)
      .bind(
        sessionId, observedAt, num(data.station_id), num(data.queue_id), num(data.start_time), num(track.position),
        num(track.queue_track_id), num(track.stationhead_track_id), text(track.spotify_id),
        text(track.deezer_id), text(track.isrc), num(track.duration_ms), text(track.preview_url), num(track.bite_count),
      )));
  }

  const count = await db.prepare(`SELECT COUNT(DISTINCT COALESCE(
      CAST(stationhead_track_id AS TEXT),spotify_id,CAST(queue_track_id AS TEXT))) AS count
    FROM sh_host_queue_items WHERE session_id=?`).bind(sessionId).first();
  await db.prepare(`UPDATE sh_host_broadcast_sessions SET track_count=? WHERE id=?`)
    .bind(num(count?.count) ?? 0, sessionId).run();
}

async function closeSession(db, observedAt, data) {
  await db.prepare(`UPDATE sh_host_broadcast_sessions SET
      ended_at=?,status=?,end_reason=?,total_listens_end=COALESCE(?,total_listens_end),
      followers_end=COALESCE(?,followers_end),total_streams_end=COALESCE(?,total_streams_end),
      average_listeners=CASE WHEN listener_sample_count>0
        THEN CAST(listener_sum AS REAL)/listener_sample_count ELSE NULL END,
      last_observed_at=?,raw_end_json=NULL WHERE id=?`)
    .bind(
      num(data.ended_at) ?? observedAt, text(data.status) || 'ended', text(data.end_reason),
      num(data.total_listens_end), num(data.followers_end), num(data.total_streams_end),
      observedAt, num(data.session_id),
    ).run();
}

async function claimForType(db, type, observedAt, data, source) {
  if (type === 'host_profile_snapshot') {
    const sessionId = num(data.session_id);
    if (sessionId == null) return null;
    return claimWrite(db, {
      dedupeKey: `profile:sakurazaka46jp:session:${sessionId}:minute:${minuteBucket(observedAt)}`,
      dataType: type,
      ...source,
      observedAt,
      payload: {
        account_id: num(data.account_id),
        followers: num(data.followers),
        total_streams: num(data.total_streams),
      },
    });
  }
  if (type === 'solo_station_snapshot') {
    return claimWrite(db, {
      dedupeKey: `solo:${num(data.session_id) ?? 0}:minute:${minuteBucket(observedAt)}`,
      dataType: type,
      ...source,
      observedAt,
      payload: stationClaimPayload(data),
    });
  }
  if (type === 'solo_queue') {
    const payload = queueClaimPayload(data);
    const hash = await payloadHash(payload);
    return claimWrite(db, {
      dedupeKey: `solo:${num(data.session_id) ?? 0}:queue:${num(data.start_time) ?? 0}:hash:${hash}`,
      dataType: type,
      ...source,
      observedAt,
      payload,
      hash,
    });
  }
  return null;
}

export async function onRequestPost({ request, env }) {
  if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);
  if (!env.OTHER_DB) return json({ ok: false, error: 'OTHER_DB binding missing' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const type = body?.type;
  const observedAt = num(body?.observed_at) ?? Date.now();
  const data = body?.data ?? {};
  const source = sourceIdentity(body, {
    collectorId: body?.collector_id,
    collectorKind: 'external',
  });

  try {
    const claim = await claimForType(env.DB, type, observedAt, data, source);
    if (claim && !claim.accepted) {
      return json({
        ok: true,
        type,
        accepted: false,
        duplicate: claim.duplicate,
        claim_reason: claim.reason,
      });
    }

    switch (type) {
      case 'host_profile_snapshot': await updateSessionProfile(env.OTHER_DB, data); break;
      case 'solo_session_open': {
        const row = await openSession(env.OTHER_DB, observedAt, data);
        return json({ ok: true, type, accepted: true, session_id: row?.id ?? null });
      }
      case 'solo_session_confirm': await confirmSession(env.OTHER_DB, observedAt, data); break;
      case 'solo_station_snapshot': await saveStationSnapshot(env.OTHER_DB, observedAt, data); break;
      case 'solo_queue': await saveQueue(env.OTHER_DB, observedAt, data); break;
      case 'solo_session_close': await closeSession(env.OTHER_DB, observedAt, data); break;
      case 'solo_comments': return json({ ok: false, error: 'use count-only solo comment ingest' }, 410);
      case 'solo_ws_event': return json({ ok: false, error: 'raw solo event ingest retired' }, 410);
      default: return json({ ok: false, error: `unknown type: ${type}` }, 400);
    }
    return json({ ok: true, type, accepted: true });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'database error' }, 500);
  }
}

export async function onRequestGet() {
  return json({
    ok: true,
    endpoint: 'Sakurazaka host monitoring ingest',
    accepted_types: [
      'host_profile_snapshot','solo_session_open','solo_session_confirm',
      'solo_station_snapshot','solo_queue','solo_session_close',
    ],
  });
}
