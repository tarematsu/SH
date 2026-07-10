import { claimWrite, minuteBucket, payloadHash, sourceIdentity } from '../lib/ingest-claim.js';
import { json, authorized, num, bool, text, rawJson } from '../lib/api-utils.js';

function snapshotClaimPayload(d) {
  return {
    channel_id: num(d.channel_id),
    station_id: num(d.station_id),
    is_launched: bool(d.is_launched),
    is_broadcasting: bool(d.is_broadcasting),
    listener_count: num(d.listener_count),
    online_member_count: num(d.online_member_count),
    total_member_count: num(d.total_member_count),
    guest_count: num(d.guest_count),
    total_listens: num(d.total_listens),
    stream_goal: num(d.stream_goal),
    current_stream_count: num(d.current_stream_count),
    host_account_id: num(d.host_account_id),
    host_handle: text(d.host_handle),
    broadcast_start_time: num(d.broadcast_start_time),
  };
}

function snapshotRawPayload(d) {
  const raw = d?.raw || {};
  const station = raw.current_station || {};
  const owner = station.owner || {};
  return {
    ...snapshotClaimPayload(d),
    description: text(raw.description || station.status),
    artist_name: text(raw.artist_name),
    accent_color: text(raw.accent_color),
    images: {
      medium: { url: text(raw.images?.medium?.url) },
      logo: { medium: { url: text(raw.images?.logo?.medium?.url) } },
    },
    current_station: {
      status: text(station.status),
      streaming_party: {
        current_stream_count: num(station.streaming_party?.current_stream_count),
        stream_goal: num(station.streaming_party?.stream_goal),
      },
      owner: {
        thumbnail: { url: text(owner.thumbnail?.url) },
        medium: { url: text(owner.medium?.url) },
      },
    },
  };
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
      isrc: text(track.isrc),
      duration_ms: num(track.duration_ms),
      bite_count: num(track.bite_count),
    })),
  };
}

async function saveSnapshot(db, observedAt, d) {
  const bucket = minuteBucket(observedAt);
  const channelId = num(d.channel_id);
  const values = [
    observedAt, channelId, text(d.channel_alias), text(d.channel_name),
    num(d.station_id), bool(d.is_launched), bool(d.is_broadcasting), text(d.chat_status),
    num(d.listener_count), num(d.online_member_count), num(d.total_member_count),
    num(d.guest_count), num(d.total_listens), num(d.stream_goal),
    num(d.current_stream_count), num(d.host_account_id), text(d.host_handle),
    num(d.broadcast_start_time), num(d.comment_velocity), rawJson(snapshotRawPayload(d)),
  ];

  const updated = await db.prepare(`
    UPDATE sh_channel_snapshots SET
      observed_at=?, channel_id=?, channel_alias=?, channel_name=?,
      station_id=?, is_launched=?, is_broadcasting=?, chat_status=?,
      listener_count=?, online_member_count=?, total_member_count=?,
      guest_count=?, total_listens=?, stream_goal=?,
      current_stream_count=?, host_account_id=?, host_handle=?,
      broadcast_start_time=?, comment_velocity=COALESCE(?,comment_velocity), raw_json=?
    WHERE id=(
      SELECT id FROM sh_channel_snapshots
      WHERE channel_id IS ? AND observed_at>=? AND observed_at<?
      ORDER BY observed_at DESC, id DESC LIMIT 1
    )
  `).bind(...values, channelId, bucket, bucket + 60000).run();

  if (Number(updated?.meta?.changes || 0) > 0) return;

  await db.prepare(`
    INSERT INTO sh_channel_snapshots (
      observed_at, channel_id, channel_alias, channel_name,
      station_id, is_launched, is_broadcasting, chat_status,
      listener_count, online_member_count, total_member_count,
      guest_count, total_listens, stream_goal,
      current_stream_count, host_account_id, host_handle,
      broadcast_start_time, comment_velocity, raw_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(...values).run();
}

async function saveComments(db, observedAt, data) {
  const comments = Array.isArray(data?.comments) ? data.comments : [];
  const statements = comments.map((c) =>
    db.prepare(`
      INSERT INTO sh_comments (
        id, observed_at, station_id, account_id, handle, text, text_with_xml,
        chat_time, chat_time_ms, all_access_chat, boost_chat,
        active_stream_days, followers, following, emoji, raw_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        station_id=excluded.station_id, account_id=excluded.account_id,
        handle=excluded.handle, text=excluded.text,
        text_with_xml=excluded.text_with_xml,
        chat_time=excluded.chat_time, chat_time_ms=excluded.chat_time_ms,
        all_access_chat=excluded.all_access_chat, boost_chat=excluded.boost_chat,
        active_stream_days=excluded.active_stream_days,
        followers=excluded.followers, following=excluded.following,
        emoji=excluded.emoji, raw_json=excluded.raw_json
      WHERE excluded.raw_json IS NOT sh_comments.raw_json
    `).bind(
      num(c.id), observedAt, num(c.station_id), num(c.account_id),
      text(c.handle), text(c.text), text(c.text_with_xml),
      num(c.chat_time), num(c.chat_time_ms),
      bool(c.all_access_chat), bool(c.boost_chat),
      num(c.active_stream_days), num(c.followers), num(c.following),
      text(c.emoji), rawJson(c.raw),
    ),
  );

  if (statements.length) await db.batch(statements);

  const stationId = num(data?.station_id ?? comments.find((c) => num(c.station_id) !== null)?.station_id);
  if (stationId !== null) {
    const velocityRow = await db.prepare(`
      SELECT COUNT(*) AS count FROM sh_comments
      WHERE station_id=?
        AND COALESCE(chat_time_ms, chat_time*1000, observed_at) > ?
        AND COALESCE(chat_time_ms, chat_time*1000, observed_at) <= ?
    `).bind(stationId, observedAt - 120000, observedAt).first();

    const velocity = num(velocityRow?.count) ?? 0;
    await db.prepare(`
      UPDATE sh_channel_snapshots SET comment_velocity=?
      WHERE id=(
        SELECT id FROM sh_channel_snapshots
        WHERE station_id=? AND observed_at<=?
        ORDER BY observed_at DESC LIMIT 1
      )
    `).bind(velocity, stationId, observedAt).run();
  }
}

function observationTrackKey(t) {
  return text(t?.queue_track_id)
    || text(t?.stationhead_track_id)
    || text(t?.spotify_id)
    || text(t?.isrc)
    || `position:${num(t?.position) ?? -1}`;
}

async function saveLikeObservations(db, observedAt, data) {
  const stationId = num(data?.station_id);
  const queueId = num(data?.queue_id);
  const startTime = num(data?.start_time);
  const tracks = Array.isArray(data?.tracks) ? data.tracks : [];

  for (const t of tracks) {
    const likeCount = num(t?.bite_count);
    if (likeCount === null) continue;

    const trackKey = observationTrackKey(t);
    const latest = await db.prepare(`
      SELECT observed_at, like_count FROM sh_track_like_observations
      WHERE station_id IS ? AND track_key=?
      ORDER BY observed_at DESC, id DESC LIMIT 1
    `).bind(stationId, trackKey).first();

    const changed = !latest || num(latest.like_count) !== likeCount;
    const checkpoint = !latest || observedAt - num(latest.observed_at) >= 3600000;
    if (!changed && !checkpoint) continue;

    await db.prepare(`
      INSERT OR IGNORE INTO sh_track_like_observations (
        observed_at, station_id, queue_id, start_time, position,
        queue_track_id, stationhead_track_id, spotify_id, apple_music_id, isrc,
        track_key, like_count, source, raw_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      observedAt, stationId, queueId, startTime, num(t.position),
      num(t.queue_track_id), num(t.stationhead_track_id),
      text(t.spotify_id), text(t.apple_music_id), text(t.isrc),
      trackKey, likeCount, 'collector', rawJson(t.raw ?? t),
    ).run();
  }
}

async function saveQueue(db, observedAt, data) {
  const stationId = num(data?.station_id);
  const queueId = num(data?.queue_id);
  const startTime = num(data?.start_time);
  const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
  const bucket = minuteBucket(observedAt);

  await db.prepare(`
    INSERT INTO sh_queue_snapshots (
      observed_at, station_id, queue_id, start_time, is_paused, raw_json
    ) SELECT ?,?,?,?,?,?
    WHERE NOT EXISTS (
      SELECT 1 FROM sh_queue_snapshots
      WHERE station_id IS ? AND start_time IS ?
        AND observed_at>=? AND observed_at<?
    )
  `).bind(
    observedAt, stationId, queueId, startTime,
    bool(data?.is_paused), rawJson(queueClaimPayload(data)),
    stationId, startTime, bucket, bucket + 60000,
  ).run();

  if (tracks.length) {
    const statements = tracks.map((t) =>
      db.prepare(`
        INSERT INTO sh_queue_items (
          observed_at, station_id, queue_id, start_time, position,
          queue_track_id, stationhead_track_id, spotify_id, apple_music_id,
          deezer_id, isrc, duration_ms, preview_url, bite_count, raw_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(station_id, start_time, position) DO UPDATE SET
          observed_at=excluded.observed_at, queue_id=excluded.queue_id,
          queue_track_id=excluded.queue_track_id,
          stationhead_track_id=excluded.stationhead_track_id,
          spotify_id=excluded.spotify_id, apple_music_id=excluded.apple_music_id,
          deezer_id=excluded.deezer_id, isrc=excluded.isrc,
          duration_ms=excluded.duration_ms, preview_url=excluded.preview_url,
          bite_count=excluded.bite_count, raw_json=excluded.raw_json
        WHERE excluded.raw_json IS NOT sh_queue_items.raw_json
          OR excluded.bite_count IS NOT sh_queue_items.bite_count
          OR excluded.observed_at - sh_queue_items.observed_at >= 3600000
      `).bind(
        observedAt, stationId, queueId, startTime, num(t.position),
        num(t.queue_track_id), num(t.stationhead_track_id),
        text(t.spotify_id), text(t.apple_music_id), text(t.deezer_id),
        text(t.isrc), num(t.duration_ms), text(t.preview_url),
        num(t.bite_count), rawJson(t.raw),
      ),
    );
    await db.batch(statements);
  }

  await saveLikeObservations(db, observedAt, data);
}

async function saveTrackMetadata(db, observedAt, data) {
  const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
  const statements = tracks.filter((t) => t?.spotify_id).map((t) =>
    db.prepare(`
      INSERT INTO sh_track_metadata (
        spotify_id, title, artist, display_title, thumbnail_url,
        spotify_url, source, fetched_at, raw_json
      ) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(spotify_id) DO UPDATE SET
        title=COALESCE(excluded.title, sh_track_metadata.title),
        artist=COALESCE(excluded.artist, sh_track_metadata.artist),
        display_title=COALESCE(excluded.display_title, sh_track_metadata.display_title),
        thumbnail_url=COALESCE(excluded.thumbnail_url, sh_track_metadata.thumbnail_url),
        spotify_url=COALESCE(excluded.spotify_url, sh_track_metadata.spotify_url),
        source=excluded.source,
        fetched_at=MAX(excluded.fetched_at, sh_track_metadata.fetched_at),
        raw_json=COALESCE(excluded.raw_json, sh_track_metadata.raw_json)
    `).bind(
      text(t.spotify_id), text(t.title), text(t.artist),
      text(t.display_title), text(t.thumbnail_url), text(t.spotify_url),
      text(t.source || 'spotify_oembed'), num(t.fetched_at) ?? observedAt,
      rawJson(t.raw),
    ),
  );
  if (statements.length) await db.batch(statements);
}

async function saveWsEvent(db, observedAt, data) {
  const raw = rawJson(data?.raw);
  const bucket = Math.floor(observedAt / 5000) * 5000;

  await db.prepare(`
    INSERT INTO sh_raw_events (observed_at, source, channel, event, data_json, raw_json)
    SELECT ?, 'websocket', ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM sh_raw_events
      WHERE source='websocket' AND channel IS ? AND event IS ?
        AND observed_at>=? AND observed_at<? AND raw_json=?
    )
  `).bind(
    observedAt, text(data?.channel), text(data?.event),
    rawJson(data?.data), raw,
    text(data?.channel), text(data?.event),
    bucket, bucket + 5000, raw,
  ).run();

  const event = data?.event;
  const d = data?.data || {};
  if (!['listenerCount', 'onlineMemberCount', 'streamingPartyUpdated'].includes(event)) return;

  await db.prepare(`
    INSERT INTO sh_realtime_metrics (
      observed_at, event, listener_count, online_member_count,
      stream_goal, current_stream_count, account_id, change_type, raw_json
    ) SELECT ?,?,?,?,?,?,?,?,?
    WHERE NOT EXISTS (
      SELECT 1 FROM sh_realtime_metrics
      WHERE event=? AND observed_at>=? AND observed_at<? AND raw_json=?
    )
  `).bind(
    observedAt, text(event), num(d.listener_count), num(d.online_member_count),
    num(d.stream_goal), num(d.current_stream_count),
    num(d.account_id), text(d.type), rawJson(d),
    text(event), bucket, bucket + 5000, rawJson(d),
  ).run();
}

async function saveHeartbeat(db, observedAt, data) {
  await db.prepare(`
    INSERT INTO sh_collector_heartbeats (
      collector_id, first_seen_at, last_seen_at, hostname, version, metadata_json
    ) VALUES (?,?,?,?,?,?)
    ON CONFLICT(collector_id) DO UPDATE SET
      last_seen_at=excluded.last_seen_at, hostname=excluded.hostname,
      version=excluded.version, metadata_json=excluded.metadata_json
  `).bind(
    text(data?.collector_id), observedAt, observedAt,
    text(data?.hostname), text(data?.version), rawJson(data),
  ).run();
}

export async function onRequestPost({ request, env }) {
  if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }

  const type = body?.type;
  const observedAt = num(body?.observed_at) ?? Date.now();
  const data = body?.data ?? {};
  const source = sourceIdentity(body, {
    collectorId: body?.collector_id,
    collectorKind: 'external',
    sourcePriority: 50,
  });
  let claim = null;

  try {
    if (type === 'snapshot') {
      const channelId = num(data.channel_id) ?? 0;
      const bucket = minuteBucket(observedAt);
      const payload = snapshotClaimPayload(data);
      claim = await claimWrite(env.DB, {
        dedupeKey: `channel:${channelId}:minute:${bucket}`,
        dataType: type,
        ...source,
        observedAt,
        payload,
        metadata: { channel_id: channelId, minute: bucket },
      });
      if (claim.accepted) await saveSnapshot(env.DB, observedAt, data);
    } else if (type === 'comments') {
      await saveComments(env.DB, observedAt, data);
    } else if (type === 'queue') {
      const payload = queueClaimPayload(data);
      const hash = await payloadHash(payload);
      claim = await claimWrite(env.DB, {
        dedupeKey: `station:${num(data.station_id) ?? 0}:queue:${num(data.start_time) ?? 0}:minute:${minuteBucket(observedAt)}:hash:${hash}`,
        dataType: type,
        ...source,
        observedAt,
        hash,
        payload,
        metadata: { station_id: num(data.station_id), start_time: num(data.start_time) },
      });
      if (claim.accepted) await saveQueue(env.DB, observedAt, data);
    } else if (type === 'track_metadata') {
      await saveTrackMetadata(env.DB, observedAt, data);
    } else if (['ws_event', 'raw_event', 'realtime'].includes(type)) {
      await saveWsEvent(env.DB, observedAt, data);
    } else if (type === 'collector_heartbeat') {
      await saveHeartbeat(env.DB, observedAt, {
        ...data,
        collector_id: data?.collector_id || source.collectorId,
        collector_kind: source.collectorKind,
        source_priority: source.sourcePriority,
      });
    } else {
      return json({ ok: false, error: `unknown type: ${type}` }, 400);
    }

    return json({
      ok: true,
      type,
      accepted: claim ? claim.accepted : true,
      duplicate: claim?.duplicate || false,
      claim_reason: claim?.reason || null,
    });
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

    const ids = [...new Set(
      (url.searchParams.get('ids') || '').split(',').map((v) => v.trim()).filter(Boolean),
    )].slice(0, 100);
    if (!ids.length) return json({ ok: true, tracks: [] });

    const placeholders = ids.map(() => '?').join(',');
    const result = await env.DB.prepare(`
      SELECT spotify_id, title, artist, display_title, thumbnail_url,
             spotify_url, source, fetched_at
      FROM sh_track_metadata
      WHERE spotify_id IN (${placeholders})
    `).bind(...ids).all();

    return json({ ok: true, tracks: result.results || [] });
  }

  return json({
    ok: true,
    endpoint: 'sh ingest',
    acceptedTypes: ['snapshot', 'comments', 'queue', 'track_metadata', 'ws_event', 'collector_heartbeat'],
  });
}
