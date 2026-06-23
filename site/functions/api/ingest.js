function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function authorized(request, env) {
  const expected = env.INGEST_SECRET;
  if (!expected) return false;
  const auth = request.headers.get('authorization') || '';
  return auth === `Bearer ${expected}`;
}

function num(value) {
  return value === undefined || value === null || value === '' ? null : Number(value);
}
function bool(value) {
  return value === undefined || value === null ? null : value ? 1 : 0;
}
function text(value) {
  return value === undefined || value === null ? null : String(value);
}
function rawJson(value) {
  return JSON.stringify(value ?? null);
}

async function saveSnapshot(db, observedAt, d) {
  await db.prepare(`
    INSERT INTO sh_channel_snapshots (
      observed_at, channel_id, channel_alias, channel_name, station_id,
      is_launched, is_broadcasting, chat_status,
      listener_count, online_member_count, total_member_count, guest_count,
      total_listens, stream_goal, current_stream_count,
      host_account_id, host_handle, broadcast_start_time, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    observedAt, num(d.channel_id), text(d.channel_alias), text(d.channel_name), num(d.station_id),
    bool(d.is_launched), bool(d.is_broadcasting), text(d.chat_status),
    num(d.listener_count), num(d.online_member_count), num(d.total_member_count), num(d.guest_count),
    num(d.total_listens), num(d.stream_goal), num(d.current_stream_count),
    num(d.host_account_id), text(d.host_handle), num(d.broadcast_start_time), rawJson(d.raw)
  ).run();
}

async function saveComments(db, observedAt, data) {
  const sh_comments = Array.isArray(data?.sh_comments) ? data.sh_comments : [];
  const statements = sh_comments.map((c) => db.prepare(`
    INSERT INTO sh_comments (
      id, observed_at, station_id, account_id, handle, text, text_with_xml,
      chat_time, chat_time_ms, all_access_chat, boost_chat, active_stream_days,
      followers, following, emoji, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      observed_at=excluded.observed_at,
      handle=excluded.handle,
      text=excluded.text,
      text_with_xml=excluded.text_with_xml,
      followers=excluded.followers,
      following=excluded.following,
      emoji=excluded.emoji,
      raw_json=excluded.raw_json
  `).bind(
    num(c.id), observedAt, num(c.station_id), num(c.account_id), text(c.handle), text(c.text), text(c.text_with_xml),
    num(c.chat_time), num(c.chat_time_ms), bool(c.all_access_chat), bool(c.boost_chat), num(c.active_stream_days),
    num(c.followers), num(c.following), text(c.emoji), rawJson(c.raw)
  ));
  if (statements.length) await db.batch(statements);
}

async function saveQueue(db, observedAt, data) {
  const stationId = num(data?.station_id);
  const queueId = num(data?.queue_id);
  const startTime = num(data?.start_time);
  const tracks = Array.isArray(data?.tracks) ? data.tracks : [];

  await db.prepare(`
    INSERT INTO sh_queue_snapshots (observed_at, station_id, queue_id, start_time, is_paused, raw_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(observedAt, stationId, queueId, startTime, bool(data?.is_paused), rawJson(data?.raw)).run();

  const statements = tracks.map((t) => db.prepare(`
    INSERT INTO sh_queue_items (
      observed_at, station_id, queue_id, start_time, position,
      queue_track_id, stationhead_track_id, spotify_id, apple_music_id,
      deezer_id, isrc, duration_ms, preview_url, bite_count, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(station_id, start_time, position) DO UPDATE SET
      queue_track_id=excluded.queue_track_id,
      stationhead_track_id=excluded.stationhead_track_id,
      spotify_id=excluded.spotify_id,
      apple_music_id=excluded.apple_music_id,
      deezer_id=excluded.deezer_id,
      isrc=excluded.isrc,
      duration_ms=excluded.duration_ms,
      preview_url=excluded.preview_url,
      bite_count=excluded.bite_count,
      raw_json=excluded.raw_json
  `).bind(
    observedAt, stationId, queueId, startTime, num(t.position),
    num(t.queue_track_id), num(t.stationhead_track_id), text(t.spotify_id), text(t.apple_music_id),
    text(t.deezer_id), text(t.isrc), num(t.duration_ms), text(t.preview_url), num(t.bite_count), rawJson(t.raw)
  ));
  if (statements.length) await db.batch(statements);
}

async function saveWsEvent(db, observedAt, data) {
  await db.prepare(`
    INSERT INTO sh_raw_events (observed_at, source, channel, event, data_json, raw_json)
    VALUES (?, 'websocket', ?, ?, ?, ?)
  `).bind(observedAt, text(data?.channel), text(data?.event), rawJson(data?.data), rawJson(data?.raw)).run();

  const event = data?.event;
  const d = data?.data || {};
  if (event === 'listenerCount' || event === 'onlineMemberCount' || event === 'streamingPartyUpdated') {
    await db.prepare(`
      INSERT INTO sh_realtime_metrics (
        observed_at, event, listener_count, online_member_count,
        stream_goal, current_stream_count, account_id, change_type, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      observedAt, text(event), num(d.listener_count), num(d.online_member_count),
      num(d.stream_goal), num(d.current_stream_count), num(d.account_id), text(d.type), rawJson(d)
    ).run();
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }

  const type = body?.type;
  const observedAt = num(body?.observed_at) || Date.now();
  const data = body?.data ?? {};

  try {
    if (type === 'snapshot') await saveSnapshot(env.DB, observedAt, data);
    else if (type === 'sh_comments') await saveComments(env.DB, observedAt, data);
    else if (type === 'queue') await saveQueue(env.DB, observedAt, data);
    else if (type === 'ws_event') await saveWsEvent(env.DB, observedAt, data);
    else return json({ ok: false, error: `unknown type: ${type}` }, 400);
    return json({ ok: true, type });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'database error' }, 500);
  }
}

export async function onRequestGet() {
  return json({ ok: true, endpoint: 'stationhead ingest' });
}

