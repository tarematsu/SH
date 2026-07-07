import { normalizeComments as normalizeStationheadComments } from './shared.js';
import {
  OFFICIAL_NEWS_STATE_ID,
  STATIONHEAD_ORIGIN,
  finite,
  timedFetch,
} from './official-news-utils.js';
import { checkOfficialNews } from './official-news-announcements.js';

function stationHeaders(cfg, session) {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
    'app-platform': 'web',
    'app-version': cfg.appVersion,
    'content-type': 'application/json',
    origin: 'https://www.stationhead.com',
    referer: 'https://www.stationhead.com/',
    'sth-device-uid': session.device_uid,
    authorization: `Bearer ${session.auth_token}`,
  };
}

export const OFFICIAL_PROBE_CONTEXT_SQL = `SELECT
  collector.auth_token,collector.device_uid,
  (SELECT station_id FROM sh_channel_snapshots
    WHERE station_id IS NOT NULL
    ORDER BY observed_at DESC,id DESC LIMIT 1) AS buddies_station_id
FROM sh_worker_collector_state collector
WHERE collector.id='stationhead' LIMIT 1`;

export async function loadOfficialProbeContext(env) {
  return env.DB.prepare(OFFICIAL_PROBE_CONTEXT_SQL).first();
}

async function stationRequest(path, cfg, session, options = {}) {
  const response = await timedFetch(`${STATIONHEAD_ORIGIN}${path}`, {
    ...options,
    headers: { ...stationHeaders(cfg, session), ...(options.headers || {}) },
  }, cfg.requestTimeoutMs);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Stationhead ${response.status}: ${path}${body ? ` | ${body.slice(0, 180)}` : ''}`);
  }
  return response.json();
}

function stationIdentity(station) {
  const broadcast = station?.broadcast || {};
  return {
    stationId: finite(station?.id ?? broadcast?.station_id),
    broadcastId: finite(broadcast?.id),
    broadcastStartTime: finite(broadcast?.start_time),
    channelId: finite(station?.channel?.id),
    channelAlias: station?.channel?.alias || null,
  };
}

function normalizeOfficialComments(payload) {
  return normalizeStationheadComments(payload, null, { finite }).map((comment) => ({
    commentId: finite(comment.comment_id ?? comment.id),
    accountId: comment.account_id,
    handle: comment.handle,
    text: comment.text,
    chatTime: comment.chat_time,
    chatTimeMs: comment.chat_time_ms,
    raw: comment.raw,
  })).filter((comment) => comment.commentId != null);
}

async function fetchComments(stationId, cfg, session) {
  for (const limit of [50, 20]) {
    try {
      return normalizeOfficialComments(await stationRequest(`/station/${stationId}/chatHistory?limit=${limit}`, cfg, session));
    } catch (error) {
      if (limit === 20) throw error;
    }
  }
  return [];
}

const DB_BATCH_SIZE = 80;

async function runDbBatches(db, statements) {
  for (let index = 0; index < statements.length; index += DB_BATCH_SIZE) {
    const group = statements.slice(index, index + DB_BATCH_SIZE);
    if (group.length) await db.batch(group);
  }
}

export function compactProbePayload(station, identity = stationIdentity(station)) {
  const queue = station?.queue || null;
  const queueTracks = queue?.queue_tracks || queue?.tracks || [];
  const compactQueue = queue ? {
    id: finite(queue.id),
    start_time: finite(queue.start_time),
    is_paused: queue.is_paused ?? null,
    track_count: Array.isArray(queueTracks) ? queueTracks.length : 0,
  } : null;
  return {
    queueJson: JSON.stringify(compactQueue),
    rawJson: JSON.stringify({
      station_id: identity.stationId,
      broadcast_id: identity.broadcastId,
      broadcast_start_time: identity.broadcastStartTime,
      is_broadcasting: Boolean(station?.is_broadcasting),
      listener_count: finite(station?.listener_count),
      guest_count: finite(station?.guest_count),
      total_listens: finite(station?.total_listens),
      status: station?.status || null,
      chat_status: station?.chat_status || null,
      channel_id: identity.channelId,
      channel_alias: identity.channelAlias,
    }),
  };
}

function probeStatement(env, announcement, station, active, now, identity, compact) {
  const minute = Math.floor(now / 60000);
  return env.DB.prepare(`INSERT INTO sh_official_news_station_probes
      (announcement_id,observed_at,observed_minute,station_id,broadcast_id,broadcast_start_time,
       is_broadcasting,listener_count,guest_count,total_listens,status,chat_status,
       channel_id,channel_alias,queue_json,raw_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(announcement_id,observed_minute) DO UPDATE SET
       observed_at=excluded.observed_at,station_id=excluded.station_id,broadcast_id=excluded.broadcast_id,
       broadcast_start_time=excluded.broadcast_start_time,is_broadcasting=excluded.is_broadcasting,
       listener_count=excluded.listener_count,guest_count=excluded.guest_count,total_listens=excluded.total_listens,
       status=excluded.status,chat_status=excluded.chat_status,channel_id=excluded.channel_id,
       channel_alias=excluded.channel_alias,queue_json=excluded.queue_json,raw_json=excluded.raw_json`)
    .bind(
      announcement.id, now, minute, identity.stationId, identity.broadcastId, identity.broadcastStartTime,
      active ? 1 : 0, finite(station?.listener_count), finite(station?.guest_count), finite(station?.total_listens),
      station?.status || null, station?.chat_status || null, identity.channelId, identity.channelAlias,
      compact.queueJson, compact.rawJson,
    );
}

async function loadExistingOfficialComments(env, announcementIds, commentIds) {
  if (!announcementIds.length || !commentIds.length) return [];
  const announcementPlaceholders = announcementIds.map(() => '?').join(',');
  const commentPlaceholders = commentIds.map(() => '?').join(',');
  const result = await env.DB.prepare(`SELECT announcement_id,comment_id,raw_json
    FROM sh_official_news_comments
    WHERE announcement_id IN (${announcementPlaceholders})
      AND comment_id IN (${commentPlaceholders})`)
    .bind(...announcementIds, ...commentIds).all();
  return result.results || [];
}

export function officialCommentsToWrite(announcements, comments, existingRows) {
  const existing = new Map((existingRows || []).map((row) => [
    `${row.announcement_id}:${row.comment_id}`,
    row.raw_json,
  ]));
  const encodedComments = (comments || []).map((comment) => ({
    comment,
    raw: JSON.stringify(comment.raw),
  }));
  const result = [];
  for (const announcement of announcements || []) {
    for (const { comment, raw } of encodedComments) {
      const key = `${announcement.id}:${comment.commentId}`;
      if (!existing.has(key) || existing.get(key) !== raw) {
        result.push({ announcementId: announcement.id, comment, raw });
      }
    }
  }
  return result;
}

export function officialCommentWriteCounts(changedComments) {
  const counts = new Map();
  for (const item of changedComments || []) {
    const id = Number(item.announcementId);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function commentStatement(env, announcementId, stationId, comment, now, raw) {
  return env.DB.prepare(`INSERT INTO sh_official_news_comments
      (announcement_id,station_id,comment_id,observed_at,account_id,handle,text,chat_time,chat_time_ms,raw_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(announcement_id,comment_id) DO UPDATE SET
       observed_at=excluded.observed_at,account_id=excluded.account_id,handle=excluded.handle,
       text=excluded.text,chat_time=excluded.chat_time,chat_time_ms=excluded.chat_time_ms,raw_json=excluded.raw_json`)
    .bind(
      announcementId, stationId, comment.commentId, now, comment.accountId, comment.handle,
      comment.text, comment.chatTime, comment.chatTimeMs, raw,
    );
}

async function dueAnnouncements(env, cfg, now) {
  const result = await env.DB.prepare(`SELECT
      id,event_name,scheduled_at,status,inactive_streak,first_broadcast_at
    FROM sh_official_news_announcements
    WHERE scheduled_at IS NOT NULL AND (
      (status='scheduled' AND scheduled_at>=? AND scheduled_at<=?)
      OR status='active'
    )
    ORDER BY scheduled_at ASC LIMIT 5`)
    .bind(now - cfg.lateWindowMs, now + cfg.earlyWindowMs).all();
  return result.results || [];
}

export async function probeAnnouncements(env, cfg, now) {
  const announcements = await dueAnnouncements(env, cfg, now);
  if (!announcements.length) return;

  const session = await loadOfficialProbeContext(env);
  if (!session?.auth_token || !session?.device_uid) throw new Error('Stationhead worker session unavailable');
  const station = await stationRequest(`/station/handle/${encodeURIComponent(cfg.handle)}/guest`, cfg, session, { method: 'POST', body: '{}' });
  const identity = stationIdentity(station);
  const active = Boolean(
    station?.is_broadcasting
    && station?.broadcast
    && identity.stationId
    && identity.stationId !== finite(session.buddies_station_id)
  );

  const comments = active
    ? await fetchComments(identity.stationId, cfg, session).catch((error) => {
      console.warn(JSON.stringify({ event: 'official_news_comments_failed', error: String(error?.message || error) }));
      return [];
    })
    : [];
  const announcementIds = announcements.map((announcement) => Number(announcement.id));
  const commentIds = [...new Set(comments.map((comment) => Number(comment.commentId)))];
  const existingComments = active
    ? await loadExistingOfficialComments(env, announcementIds, commentIds)
    : [];
  const changedComments = officialCommentsToWrite(announcements, comments, existingComments);
  const changedCounts = officialCommentWriteCounts(changedComments);
  const compact = compactProbePayload(station, identity);
  const statements = announcements.map((announcement) => probeStatement(
    env, announcement, station, active, now, identity, compact,
  ));

  if (active) {
    statements.push(...changedComments.map(({ announcementId, comment, raw }) => commentStatement(
      env, announcementId, identity.stationId, comment, now, raw,
    )));
    for (const announcement of announcements) {
      statements.push(env.DB.prepare(`UPDATE sh_official_news_announcements SET
          status='active',matched_station_id=?,first_broadcast_at=COALESCE(first_broadcast_at,?),
          last_broadcast_at=?,inactive_streak=0,updated_at=? WHERE id=?`)
        .bind(identity.stationId, identity.broadcastStartTime || now, now, now, announcement.id));
    }
  } else {
    for (const announcement of announcements) {
      if (announcement.status !== 'active') continue;
      const streak = Number(announcement.inactive_streak || 0) + 1;
      statements.push(env.DB.prepare(`UPDATE sh_official_news_announcements SET
          inactive_streak=?,status=CASE WHEN ?>=? THEN 'ended' ELSE status END,updated_at=? WHERE id=?`)
        .bind(streak, streak, cfg.endConfirmPolls, now, announcement.id));
    }
  }
  await runDbBatches(env.DB, statements);

  for (const announcement of announcements) {
    console.log(JSON.stringify({
      event: 'official_news_broadcast_probe',
      announcement_id: announcement.id,
      station_id: identity.stationId,
      listener_count: station?.listener_count ?? null,
      comments_fetched: comments.length,
      comments_written: changedCounts.get(Number(announcement.id)) || 0,
    }));
  }
}

export async function runOfficialNewsMonitor(env, cfg, now) {
  if (!env.DB) return;
  try {
    await checkOfficialNews(env, cfg, now);
    await probeAnnouncements(env, cfg, now);
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1000);
    console.error(JSON.stringify({ event: 'official_news_monitor_failed', error: message }));
  }
}
