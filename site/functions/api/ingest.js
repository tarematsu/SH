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
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function bool(value) { return value === undefined || value === null ? null : value ? 1 : 0; }
function text(value) { return value === undefined || value === null ? null : String(value); }
function rawJson(value) { return JSON.stringify(value ?? null); }
function minuteBucket(value) { return Math.floor(value / 60_000) * 60_000; }

async function saveSnapshot(db, observedAt, d) {
  const bucket = minuteBucket(observedAt);
  await db.prepare(`
    INSERT INTO sh_channel_snapshots (
      observed_at, channel_id, channel_alias, channel_name, station_id,
      is_launched, is_broadcasting, chat_status,
      listener_count, online_member_count, total_member_count, guest_count,
      total_listens, stream_goal, current_stream_count,
      host_account_id, host_handle, broadcast_start_time, comment_velocity, raw_json
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM sh_channel_snapshots
      WHERE channel_id = ? AND observed_at >= ? AND observed_at < ?
    )
  `).bind(
    observedAt, num(d.channel_id), text(d.channel_alias), text(d.channel_name), num(d.station_id),
    bool(d.is_launched), bool(d.is_broadcasting), text(d.chat_status),
    num(d.listener_count), num(d.online_member_count), num(d.total_member_count), num(d.guest_count),
    num(d.total_listens), num(d.stream_goal), num(d.current_stream_count),
    num(d.host_account_id), text(d.host_handle), num(d.broadcast_start_time), num(d.comment_velocity), rawJson(d.raw),
    num(d.channel_id), bucket, bucket + 60_000
  ).run();
}

async function saveComments(db, observedAt, data) {
  const comments = Array.isArray(data?.comments) ? data.comments : [];
  const statements = comments.map((c) => db.prepare(`
    INSERT INTO sh_comments (
      id, observed_at, station_id, account_id, handle, text, text_with_xml,
      chat_time, chat_time_ms, all_access_chat, boost_chat, active_stream_days,
      followers, following, emoji, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      station_id=excluded.station_id,
      account_id=excluded.account_id, handle=excluded.handle, text=excluded.text,
      text_with_xml=excluded.text_with_xml, chat_time=excluded.chat_time,
      chat_time_ms=excluded.chat_time_ms, all_access_chat=excluded.all_access_chat,
      boost_chat=excluded.boost_chat, active_stream_days=excluded.active_stream_days,
      followers=excluded.followers, following=excluded.following, emoji=excluded.emoji,
      raw_json=excluded.raw_json
  `).bind(
    num(c.id), observedAt, num(c.station_id), num(c.account_id), text(c.handle), text(c.text), text(c.text_with_xml),
    num(c.chat_time), num(c.chat_time_ms), bool(c.all_access_chat), bool(c.boost_chat), num(c.active_stream_days),
    num(c.followers), num(c.following), text(c.emoji), rawJson(c.raw)
  ));
  if (statements.length) await db.batch(statements);

  const stationId = num(data?.station_id ?? comments.find((c) => num(c.station_id) !== null)?.station_id);
  if (stationId !== null) {
    const velocityRow = await db.prepare(`
      SELECT COUNT(*) AS count
      FROM sh_comments
      WHERE station_id = ?
        AND COALESCE(chat_time_ms, chat_time * 1000, observed_at) > ?
        AND COALESCE(chat_time_ms, chat_time * 1000, observed_at) <= ?
    `).bind(stationId, observedAt - 120_000, observedAt).first();
    const velocity = num(velocityRow?.count) ?? 0;
    await db.prepare(`
      UPDATE sh_channel_snapshots
      SET comment_velocity = ?
      WHERE id = (
        SELECT id FROM sh_channel_snapshots
        WHERE station_id = ? AND observed_at <= ?
        ORDER BY observed_at DESC LIMIT 1
      )
    `).bind(velocity, stationId, observedAt).run();
  }
}

async function saveQueue(db, observedAt, data) {
  const stationId = num(data?.station_id);
  const queueId = num(data?.queue_id);
  const startTime = num(data?.start_time);
  const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
  const bucket = minuteBucket(observedAt);

  await db.prepare(`
    INSERT INTO sh_queue_snapshots (observed_at, station_id, queue_id, start_time, is_paused, raw_json)
    SELECT ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM sh_queue_snapshots
      WHERE station_id = ? AND start_time = ? AND observed_at >= ? AND observed_at < ?
    )
  `).bind(
    observedAt, stationId, queueId, startTime, bool(data?.is_paused), rawJson(data?.raw),
    stationId, startTime, bucket, bucket + 60_000
  ).run();

  if (!tracks.length) return;
  const statements = tracks.map((t) => db.prepare(`
    INSERT INTO sh_queue_items (
      observed_at, station_id, queue_id, start_time, position,
      queue_track_id, stationhead_track_id, spotify_id, apple_music_id,
      deezer_id, isrc, duration_ms, preview_url, bite_count, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(station_id, start_time, position) DO UPDATE SET
      observed_at=excluded.observed_at, queue_id=excluded.queue_id,
      queue_track_id=excluded.queue_track_id, stationhead_track_id=excluded.stationhead_track_id,
      spotify_id=excluded.spotify_id, apple_music_id=excluded.apple_music_id,
      deezer_id=excluded.deezer_id, isrc=excluded.isrc, duration_ms=excluded.duration_ms,
      preview_url=excluded.preview_url, bite_count=excluded.bite_count, raw_json=excluded.raw_json
  `).bind(
    observedAt, stationId, queueId, startTime, num(t.position), num(t.queue_track_id),
    num(t.stationhead_track_id), text(t.spotify_id), text(t.apple_music_id), text(t.deezer_id),
    text(t.isrc), num(t.duration_ms), text(t.preview_url), num(t.bite_count), rawJson(t.raw)
  ));
  await db.batch(statements);
}

async function saveTrackMetadata(db, observedAt, data) {
  const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
  const statements = tracks.filter((t) => t?.spotify_id).map((t) => db.prepare(`
    INSERT INTO sh_track_metadata (
      spotify_id, title, artist, display_title, thumbnail_url, spotify_url,
      source, fetched_at, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(spotify_id) DO UPDATE SET
      title=COALESCE(excluded.title, sh_track_metadata.title),
      artist=COALESCE(excluded.artist, sh_track_metadata.artist),
      display_title=COALESCE(excluded.display_title, sh_track_metadata.display_title),
      thumbnail_url=COALESCE(excluded.thumbnail_url, sh_track_metadata.thumbnail_url),
      spotify_url=COALESCE(excluded.spotify_url, sh_track_metadata.spotify_url),
      source=excluded.source, fetched_at=MAX(excluded.fetched_at, sh_track_metadata.fetched_at),
      raw_json=COALESCE(excluded.raw_json, sh_track_metadata.raw_json)
  `).bind(
    text(t.spotify_id), text(t.title), text(t.artist), text(t.display_title), text(t.thumbnail_url),
    text(t.spotify_url), text(t.source || 'spotify_oembed'), num(t.fetched_at) ?? observedAt, rawJson(t.raw)
  ));
  if (statements.length) await db.batch(statements);
}

async function saveWsEvent(db, observedAt, data) {
  const raw = rawJson(data?.raw);
  const bucket = Math.floor(observedAt / 5_000) * 5_000;
  await db.prepare(`
    INSERT INTO sh_raw_events (observed_at, source, channel, event, data_json, raw_json)
    SELECT ?, 'websocket', ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM sh_raw_events
      WHERE source='websocket' AND channel IS ? AND event IS ?
        AND observed_at >= ? AND observed_at < ? AND raw_json = ?
    )
  `).bind(
    observedAt, text(data?.channel), text(data?.event), rawJson(data?.data), raw,
    text(data?.channel), text(data?.event), bucket, bucket + 5_000, raw
  ).run();

  const event = data?.event;
  const d = data?.data || {};
  if (!['listenerCount', 'onlineMemberCount', 'streamingPartyUpdated'].includes(event)) return;
  await db.prepare(`
    INSERT INTO sh_realtime_metrics (
      observed_at, event, listener_count, online_member_count,
      stream_goal, current_stream_count, account_id, change_type, raw_json
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM sh_realtime_metrics
      WHERE event = ? AND observed_at >= ? AND observed_at < ? AND raw_json = ?
    )
  `).bind(
    observedAt, text(event), num(d.listener_count), num(d.online_member_count), num(d.stream_goal),
    num(d.current_stream_count), num(d.account_id), text(d.type), rawJson(d),
    text(event), bucket, bucket + 5_000, rawJson(d)
  ).run();
}

async function saveHeartbeat(db, observedAt, data) {
  await db.prepare(`
    INSERT INTO sh_collector_heartbeats (collector_id, first_seen_at, last_seen_at, hostname, version, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(collector_id) DO UPDATE SET
      last_seen_at=excluded.last_seen_at, hostname=excluded.hostname,
      version=excluded.version, metadata_json=excluded.metadata_json
  `).bind(
    text(data?.collector_id), observedAt, observedAt, text(data?.hostname), text(data?.version), rawJson(data)
  ).run();
}


export async function onRequestPost({ request, env }) {
  if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const type = body?.type;
  const observedAt = num(body?.observed_at) ?? Date.now();
  const data = body?.data ?? {};
  try {
    if (type === 'snapshot') await saveSnapshot(env.DB, observedAt, data);
    else if (type === 'comments') await saveComments(env.DB, observedAt, data);
    else if (type === 'queue') await saveQueue(env.DB, observedAt, data);
    else if (type === 'track_metadata') await saveTrackMetadata(env.DB, observedAt, data);
    else if (['ws_event', 'raw_event', 'realtime'].includes(type)) await saveWsEvent(env.DB, observedAt, data);
    else if (type === 'collector_heartbeat') await saveHeartbeat(env.DB, observedAt, data);
    else return json({ ok: false, error: `unknown type: ${type}` }, 400);
    return json({ ok: true, type });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'database error' }, 500);
  }
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('type') === 'track_lookup') {
    if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
    if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);
    const ids = [...new Set((url.searchParams.get('ids') || '').split(',').map((v) => v.trim()).filter(Boolean))].slice(0, 100);
    if (!ids.length) return json({ ok: true, tracks: [] });
    const placeholders = ids.map(() => '?').join(',');
    const result = await env.DB.prepare(`
      SELECT spotify_id, title, artist, display_title, thumbnail_url, spotify_url, source, fetched_at
      FROM sh_track_metadata WHERE spotify_id IN (${placeholders})
    `).bind(...ids).all();
    return json({ ok: true, tracks: result.results || [] });
  }
  return json({
    ok: true,
    endpoint: 'stationhead ingest',
    acceptedTypes: ['snapshot', 'comments', 'queue', 'track_metadata', 'ws_event', 'collector_heartbeat'],
  });
}
