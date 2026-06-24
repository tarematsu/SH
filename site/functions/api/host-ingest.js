function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function authorized(request, env) {
  const expected = env.INGEST_SECRET;
  const auth = request.headers.get('authorization') || '';
  return Boolean(expected) && auth === `Bearer ${expected}`;
}

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bool(value) {
  if (value === undefined || value === null) return null;
  return value ? 1 : 0;
}

function text(value) {
  return value === undefined || value === null ? null : String(value);
}

function rawJson(value) {
  return JSON.stringify(value ?? null);
}

async function saveProfile(db, observedAt, data) {
  await db.prepare(`
    INSERT INTO sh_host_profile_snapshots (
      observed_at, source_scope, session_id, handle, account_id,
      followers, following, total_streams, active_stream_days, emoji,
      thumbnail_url, medium_url, main_url, badges_json, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    observedAt,
    text(data.source_scope) || 'profile_monitor',
    num(data.session_id),
    text(data.handle),
    num(data.account_id),
    num(data.followers),
    num(data.following),
    num(data.total_streams),
    num(data.active_stream_days),
    text(data.emoji),
    text(data.thumbnail_url),
    text(data.medium_url),
    text(data.main_url),
    rawJson(data.badges),
    rawJson(data.raw),
  ).run();

  if (num(data.session_id)) {
    await db.prepare(`
      UPDATE sh_host_broadcast_sessions
      SET
        account_id = COALESCE(account_id, ?),
        followers_start = COALESCE(followers_start, ?),
        total_streams_start = COALESCE(total_streams_start, ?)
      WHERE id = ?
    `).bind(
      num(data.account_id),
      num(data.followers),
      num(data.total_streams),
      num(data.session_id),
    ).run();
  }
}

async function openSession(db, observedAt, data) {
  const startedAt = num(data.started_at) ?? observedAt;
  await db.prepare(`
    INSERT INTO sh_host_broadcast_sessions (
      source_scope, handle, account_id, station_id, broadcast_id,
      broadcast_stream_id, started_at, confirmed_at, ended_at, status,
      detection_reason, end_reason, buddies_station_id, channel_id, channel_alias,
      total_listens_start, total_listens_end,
      followers_start, followers_end, total_streams_start, total_streams_end,
      peak_listeners, listener_sum, listener_sample_count, average_listeners,
      track_count, comment_count, last_observed_at, raw_start_json, raw_end_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'provisional', ?, NULL, ?, ?, ?, ?, NULL, ?, NULL, ?, NULL, NULL, 0, 0, NULL, 0, 0, ?, ?, NULL)
    ON CONFLICT(source_scope, handle, station_id, started_at) DO UPDATE SET
      account_id = COALESCE(excluded.account_id, sh_host_broadcast_sessions.account_id),
      broadcast_id = COALESCE(excluded.broadcast_id, sh_host_broadcast_sessions.broadcast_id),
      broadcast_stream_id = COALESCE(excluded.broadcast_stream_id, sh_host_broadcast_sessions.broadcast_stream_id),
      detection_reason = excluded.detection_reason,
      buddies_station_id = excluded.buddies_station_id,
      channel_id = excluded.channel_id,
      channel_alias = excluded.channel_alias,
      last_observed_at = excluded.last_observed_at,
      raw_start_json = excluded.raw_start_json
  `).bind(
    text(data.source_scope) || 'sakurazaka46jp_solo',
    text(data.handle),
    num(data.account_id),
    num(data.station_id),
    num(data.broadcast_id),
    text(data.broadcast_stream_id),
    startedAt,
    text(data.detection_reason),
    num(data.buddies_station_id),
    num(data.channel_id),
    text(data.channel_alias),
    num(data.total_listens_start),
    num(data.followers_start),
    num(data.total_streams_start),
    observedAt,
    rawJson(data.raw),
  ).run();

  return db.prepare(`
    SELECT id FROM sh_host_broadcast_sessions
    WHERE source_scope = ? AND handle = ? AND station_id = ? AND started_at = ?
    LIMIT 1
  `).bind(
    text(data.source_scope) || 'sakurazaka46jp_solo',
    text(data.handle),
    num(data.station_id),
    startedAt,
  ).first();
}

async function confirmSession(db, observedAt, data) {
  await db.prepare(`
    UPDATE sh_host_broadcast_sessions
    SET status = 'active', confirmed_at = COALESCE(confirmed_at, ?), last_observed_at = ?
    WHERE id = ?
  `).bind(num(data.confirmed_at) ?? observedAt, observedAt, num(data.session_id)).run();
}

async function saveStationSnapshot(db, observedAt, data) {
  const listener = num(data.listener_count);
  await db.prepare(`
    INSERT INTO sh_host_station_snapshots (
      session_id, observed_at, source_scope, handle, account_id,
      station_id, broadcast_id, broadcast_start_time, is_broadcasting,
      status, chat_status, listener_count, guest_count, total_listens,
      channel_id, channel_alias, current_track_id, current_spotify_id,
      queue_id, queue_start_time, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    num(data.session_id), observedAt, text(data.source_scope), text(data.handle), num(data.account_id),
    num(data.station_id), num(data.broadcast_id), num(data.broadcast_start_time), bool(data.is_broadcasting),
    text(data.status), text(data.chat_status), listener, num(data.guest_count), num(data.total_listens),
    num(data.channel_id), text(data.channel_alias), num(data.current_track_id), text(data.current_spotify_id),
    num(data.queue_id), num(data.queue_start_time), rawJson(data.raw),
  ).run();

  await db.prepare(`
    UPDATE sh_host_broadcast_sessions
    SET
      account_id = COALESCE(?, account_id),
      broadcast_id = COALESCE(?, broadcast_id),
      peak_listeners = CASE
        WHEN ? IS NULL THEN peak_listeners
        WHEN peak_listeners IS NULL OR ? > peak_listeners THEN ?
        ELSE peak_listeners
      END,
      listener_sum = listener_sum + CASE WHEN ? IS NULL THEN 0 ELSE ? END,
      listener_sample_count = listener_sample_count + CASE WHEN ? IS NULL THEN 0 ELSE 1 END,
      total_listens_end = COALESCE(?, total_listens_end),
      last_observed_at = ?
    WHERE id = ?
  `).bind(
    num(data.account_id), num(data.broadcast_id),
    listener, listener, listener,
    listener, listener,
    listener,
    num(data.total_listens), observedAt, num(data.session_id),
  ).run();
}

async function saveQueue(db, observedAt, data) {
  const sessionId = num(data.session_id);
  const tracks = Array.isArray(data.tracks) ? data.tracks : [];
  await db.prepare(`
    INSERT INTO sh_host_queue_snapshots (
      session_id, observed_at, station_id, queue_id, queue_start_time,
      is_paused, queue_hash, current_track_id, current_spotify_id, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    sessionId, observedAt, num(data.station_id), num(data.queue_id), num(data.start_time),
    bool(data.is_paused), text(data.queue_hash), num(data.current_track_id), text(data.current_spotify_id), rawJson(data.raw),
  ).run();

  if (tracks.length) {
    const statements = tracks.map((track) => db.prepare(`
      INSERT INTO sh_host_queue_items (
        session_id, observed_at, station_id, queue_id, queue_start_time, position,
        queue_track_id, stationhead_track_id, spotify_id, apple_music_id,
        deezer_id, isrc, duration_ms, preview_url, bite_count, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, queue_start_time, position) DO UPDATE SET
        observed_at = excluded.observed_at,
        queue_id = excluded.queue_id,
        queue_track_id = excluded.queue_track_id,
        stationhead_track_id = excluded.stationhead_track_id,
        spotify_id = excluded.spotify_id,
        apple_music_id = excluded.apple_music_id,
        deezer_id = excluded.deezer_id,
        isrc = excluded.isrc,
        duration_ms = excluded.duration_ms,
        preview_url = excluded.preview_url,
        bite_count = excluded.bite_count,
        raw_json = excluded.raw_json
    `).bind(
      sessionId, observedAt, num(data.station_id), num(data.queue_id), num(data.start_time), num(track.position),
      num(track.queue_track_id), num(track.stationhead_track_id), text(track.spotify_id), text(track.apple_music_id),
      text(track.deezer_id), text(track.isrc), num(track.duration_ms), text(track.preview_url), num(track.bite_count), rawJson(track.raw),
    ));
    await db.batch(statements);
  }

  const count = await db.prepare(`
    SELECT COUNT(DISTINCT COALESCE(
      CAST(stationhead_track_id AS TEXT),
      spotify_id,
      CAST(queue_track_id AS TEXT)
    )) AS count
    FROM sh_host_queue_items WHERE session_id = ?
  `).bind(sessionId).first();
  await db.prepare(`UPDATE sh_host_broadcast_sessions SET track_count = ? WHERE id = ?`)
    .bind(num(count?.count) ?? 0, sessionId).run();
}

async function saveComments(db, observedAt, data) {
  const sessionId = num(data.session_id);
  const comments = Array.isArray(data.comments) ? data.comments : [];
  if (comments.length) {
    const statements = comments.map((comment) => db.prepare(`
      INSERT INTO sh_host_comments (
        session_id, comment_id, observed_at, station_id, account_id, handle,
        text, text_with_xml, chat_time, chat_time_ms, all_access_chat,
        boost_chat, followers, following, active_stream_days, emoji, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, comment_id) DO UPDATE SET
        observed_at = excluded.observed_at,
        station_id = excluded.station_id,
        account_id = excluded.account_id,
        handle = excluded.handle,
        text = excluded.text,
        text_with_xml = excluded.text_with_xml,
        chat_time = excluded.chat_time,
        chat_time_ms = excluded.chat_time_ms,
        all_access_chat = excluded.all_access_chat,
        boost_chat = excluded.boost_chat,
        followers = excluded.followers,
        following = excluded.following,
        active_stream_days = excluded.active_stream_days,
        emoji = excluded.emoji,
        raw_json = excluded.raw_json
    `).bind(
      sessionId, num(comment.comment_id), observedAt, num(comment.station_id), num(comment.account_id), text(comment.handle),
      text(comment.text), text(comment.text_with_xml), num(comment.chat_time), num(comment.chat_time_ms), bool(comment.all_access_chat),
      bool(comment.boost_chat), num(comment.followers), num(comment.following), num(comment.active_stream_days), text(comment.emoji), rawJson(comment.raw),
    ));
    await db.batch(statements);
  }

  const count = await db.prepare(`SELECT COUNT(*) AS count FROM sh_host_comments WHERE session_id = ?`)
    .bind(sessionId).first();
  await db.prepare(`UPDATE sh_host_broadcast_sessions SET comment_count = ? WHERE id = ?`)
    .bind(num(count?.count) ?? 0, sessionId).run();
}

async function saveWsEvent(db, observedAt, data) {
  await db.prepare(`
    INSERT INTO sh_host_raw_events (
      session_id, observed_at, station_id, channel, event, data_json, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    num(data.session_id), observedAt, num(data.station_id), text(data.channel), text(data.event),
    rawJson(data.data), rawJson(data.raw),
  ).run();

  if (data.event === 'listenerCount') {
    const listener = num(data.data?.listener_count ?? data.data?.count);
    if (listener !== null) {
      await db.prepare(`
        UPDATE sh_host_broadcast_sessions
        SET
          peak_listeners = CASE WHEN peak_listeners IS NULL OR ? > peak_listeners THEN ? ELSE peak_listeners END,
          listener_sum = listener_sum + ?,
          listener_sample_count = listener_sample_count + 1,
          last_observed_at = ?
        WHERE id = ?
      `).bind(listener, listener, listener, observedAt, num(data.session_id)).run();
    }
  }
}

async function closeSession(db, observedAt, data) {
  const sessionId = num(data.session_id);
  await db.prepare(`
    UPDATE sh_host_broadcast_sessions
    SET
      ended_at = ?,
      status = ?,
      end_reason = ?,
      total_listens_end = COALESCE(?, total_listens_end),
      followers_end = COALESCE(?, followers_end),
      total_streams_end = COALESCE(?, total_streams_end),
      average_listeners = CASE
        WHEN listener_sample_count > 0 THEN CAST(listener_sum AS REAL) / listener_sample_count
        ELSE NULL
      END,
      last_observed_at = ?,
      raw_end_json = ?
    WHERE id = ?
  `).bind(
    num(data.ended_at) ?? observedAt,
    text(data.status) || 'ended',
    text(data.end_reason),
    num(data.total_listens_end),
    num(data.followers_end),
    num(data.total_streams_end),
    observedAt,
    rawJson(data.raw),
    sessionId,
  ).run();
}

export async function onRequestPost({ request, env }) {
  if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const type = body?.type;
  const observedAt = num(body?.observed_at) ?? Date.now();
  const data = body?.data ?? {};

  try {
    switch (type) {
      case 'host_profile_snapshot':
        await saveProfile(env.DB, observedAt, data);
        return json({ ok: true, type });
      case 'solo_session_open': {
        const row = await openSession(env.DB, observedAt, data);
        return json({ ok: true, type, session_id: row?.id ?? null });
      }
      case 'solo_session_confirm':
        await confirmSession(env.DB, observedAt, data);
        return json({ ok: true, type });
      case 'solo_station_snapshot':
        await saveStationSnapshot(env.DB, observedAt, data);
        return json({ ok: true, type });
      case 'solo_queue':
        await saveQueue(env.DB, observedAt, data);
        return json({ ok: true, type });
      case 'solo_comments':
        await saveComments(env.DB, observedAt, data);
        return json({ ok: true, type });
      case 'solo_ws_event':
        await saveWsEvent(env.DB, observedAt, data);
        return json({ ok: true, type });
      case 'solo_session_close':
        await closeSession(env.DB, observedAt, data);
        return json({ ok: true, type });
      default:
        return json({ ok: false, error: `unknown type: ${type}` }, 400);
    }
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'database error' }, 500);
  }
}

export async function onRequestGet() {
  return json({
    ok: true,
    endpoint: 'Stationhead host monitoring ingest',
    accepted_types: [
      'host_profile_snapshot',
      'solo_session_open',
      'solo_session_confirm',
      'solo_station_snapshot',
      'solo_queue',
      'solo_comments',
      'solo_ws_event',
      'solo_session_close',
    ],
  });
}
