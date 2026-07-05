import app from './optimized-index.js';
import { positiveNumber as positive } from './shared.js';

const NEWS_LIST_URL = 'https://sakurazaka46.com/s/s46/news/list';
const NEWS_ORIGIN = 'https://sakurazaka46.com';
const STATIONHEAD_ORIGIN = 'https://production1.stationhead.com';
const STATE_ID = 'official-news';

function finite(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function config(env) {
  return {
    checkIntervalMs: positive(env.OFFICIAL_NEWS_CHECK_INTERVAL_MS, 30 * 60 * 1000),
    earlyWindowMs: positive(env.OFFICIAL_NEWS_EARLY_WINDOW_MS, 5 * 60 * 1000),
    lateWindowMs: positive(env.OFFICIAL_NEWS_LATE_WINDOW_MS, 90 * 60 * 1000),
    endConfirmPolls: positive(env.OFFICIAL_NEWS_END_CONFIRM_POLLS, 5),
    articleLimit: Math.min(positive(env.OFFICIAL_NEWS_ARTICLE_LIMIT, 20), 40),
    bodyScanCount: Math.min(positive(env.OFFICIAL_NEWS_BODY_SCAN_COUNT, 5), 10),
    handle: env.OFFICIAL_NEWS_STATIONHEAD_HANDLE || 'sakurazaka46jp',
    appVersion: env.STATIONHEAD_APP_VERSION || '1.0.0',
    requestTimeoutMs: Math.min(positive(env.REQUEST_TIMEOUT_MS, 20_000), 30_000),
  };
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&nbsp;', ' ');
}

function stripHtml(html) {
  return decodeHtml(String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/div>|<\/li>|<\/h\d>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[\t\r ]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function articleLinks(html, limit) {
  const links = [];
  const seen = new Set();
  const pattern = /<a\b[^>]*href=["']([^"']*\/news\/detail\/[^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html)) && links.length < limit) {
    const href = new URL(match[1], NEWS_ORIGIN).toString();
    const newsId = href.match(/\/news\/detail\/([^/?#]+)/i)?.[1];
    const listTitle = stripHtml(match[2]);
    if (!newsId || seen.has(newsId)) continue;
    seen.add(newsId);
    links.push({ newsId, href, listTitle });
  }
  return links;
}

function articleTitle(html, fallback) {
  const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || fallback || '');
  return title.replace(/\s*\|\s*ニュース\s*\|\s*櫻坂46公式サイト\s*$/i, '').trim() || fallback;
}

function articleContent(html, title) {
  const text = stripHtml(html);
  const end = text.indexOf('NEW ENTRY');
  const articleArea = end >= 0 ? text.slice(0, end) : text;
  const titleIndex = articleArea.lastIndexOf(title);
  const start = titleIndex >= 0 ? Math.max(0, titleIndex - 80) : Math.max(0, articleArea.length - 12000);
  return articleArea.slice(start).trim();
}

function publishedDate(text) {
  const match = String(text || '').match(/(20\d{2})[.年\/-](\d{1,2})[.月\/-](\d{1,2})日?/);
  return match ? `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}` : null;
}

function jstTimestamp(year, month, day, hour, minute) {
  const extraDays = Math.floor(hour / 24);
  const normalizedHour = hour % 24;
  return Date.UTC(year, month - 1, day + extraDays, normalizedHour - 9, minute);
}

function scheduleTimes(text, fallbackYear) {
  const values = new Set();
  const full = /(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s*[（(][^）)]*[）)])?\s*(\d{1,2})\s*[:：]\s*(\d{2})/g;
  let match;
  while ((match = full.exec(text))) values.add(jstTimestamp(...match.slice(1, 6).map(Number)));

  const partial = /(?<!\d)(\d{1,2})月\s*(\d{1,2})日(?:\s*[（(][^）)]*[）)])?\s*(\d{1,2})\s*[:：]\s*(\d{2})/g;
  while ((match = partial.exec(text))) {
    const [month, day, hour, minute] = match.slice(1, 5).map(Number);
    values.add(jstTimestamp(fallbackYear, month, day, hour, minute));
  }
  return [...values].filter(Number.isFinite).sort((a, b) => a - b);
}

function eventName(title) {
  return String(title || '櫻坂46 Stationhead')
    .replace(/\s*開催決定[！!。]?\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function timedFetch(url, options, timeoutMs) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

async function monitorState(env) {
  return env.DB.prepare(`SELECT last_check_at,last_success_at,last_error FROM sh_official_news_monitor_state WHERE id=?`)
    .bind(STATE_ID).first();
}

async function saveMonitorState(env, values) {
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO sh_official_news_monitor_state
      (id,last_check_at,last_success_at,last_error,updated_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        last_check_at=excluded.last_check_at,
        last_success_at=excluded.last_success_at,
        last_error=excluded.last_error,
        updated_at=excluded.updated_at`)
    .bind(STATE_ID, values.lastCheckAt ?? now, values.lastSuccessAt ?? null, values.lastError ?? null, now).run();
}

async function saveAnnouncement(env, article, scheduledAt, detectedAt) {
  const rawText = article.text.slice(0, 50000);
  if (scheduledAt) {
    const row = await env.DB.prepare(`INSERT INTO sh_official_news_announcements
        (news_id,news_url,published_date,title,event_name,scheduled_at,detected_at,updated_at,status,raw_text)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(news_id,scheduled_at) DO UPDATE SET
          news_url=excluded.news_url,published_date=excluded.published_date,
          title=excluded.title,event_name=excluded.event_name,
          updated_at=excluded.updated_at,raw_text=excluded.raw_text
        WHERE news_url IS NOT excluded.news_url
          OR published_date IS NOT excluded.published_date
          OR title IS NOT excluded.title
          OR event_name IS NOT excluded.event_name
          OR raw_text IS NOT excluded.raw_text
        RETURNING id`)
      .bind(
        article.newsId, article.href, article.publishedDate, article.title, article.eventName,
        scheduledAt, detectedAt, detectedAt, 'scheduled', rawText,
      ).first();
    return Number(row?.id || 0);
  }

  const existing = await env.DB.prepare(`SELECT id FROM sh_official_news_announcements
      WHERE news_id=? AND scheduled_at IS NULL LIMIT 1`)
    .bind(article.newsId).first();
  if (existing?.id) {
    await env.DB.prepare(`UPDATE sh_official_news_announcements SET
        news_url=?,published_date=?,title=?,event_name=?,updated_at=?,raw_text=?
        WHERE id=? AND (
          news_url IS NOT ? OR published_date IS NOT ? OR title IS NOT ?
          OR event_name IS NOT ? OR raw_text IS NOT ?
        )`)
      .bind(
        article.href, article.publishedDate, article.title, article.eventName,
        detectedAt, rawText, existing.id,
        article.href, article.publishedDate, article.title, article.eventName, rawText,
      ).run();
    return Number(existing.id);
  }

  const result = await env.DB.prepare(`INSERT INTO sh_official_news_announcements
      (news_id,news_url,published_date,title,event_name,scheduled_at,detected_at,updated_at,status,raw_text)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      article.newsId, article.href, article.publishedDate, article.title, article.eventName,
      null, detectedAt, detectedAt, 'time_unknown', rawText,
    ).run();
  return Number(result?.meta?.last_row_id || 0);
}

async function markMissedAnnouncements(env, cfg, now) {
  await env.DB.prepare(`UPDATE sh_official_news_announcements SET status='missed',updated_at=?
    WHERE status='scheduled' AND scheduled_at IS NOT NULL AND scheduled_at<?`)
    .bind(now, now - cfg.lateWindowMs).run();
}

async function checkOfficialNews(env, cfg, now) {
  const state = await monitorState(env);
  if (Number(state?.last_check_at || 0) && now - Number(state.last_check_at) < cfg.checkIntervalMs) return;

  try {
    await markMissedAnnouncements(env, cfg, now);
    const response = await timedFetch(NEWS_LIST_URL, {
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'stationhead-monitor/1.0' },
      cf: { cacheEverything: true, cacheTtl: Math.floor(cfg.checkIntervalMs / 1000) },
    }, cfg.requestTimeoutMs);
    if (!response.ok) throw new Error(`official news list HTTP ${response.status}`);
    const html = await response.text();
    const links = articleLinks(html, cfg.articleLimit);
    const candidates = links.filter((link, index) => index < cfg.bodyScanCount || /station\s*head/i.test(link.listTitle));

    for (const link of candidates) {
      const detailResponse = await timedFetch(link.href, {
        headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'stationhead-monitor/1.0' },
        cf: { cacheEverything: true, cacheTtl: Math.floor(cfg.checkIntervalMs / 1000) },
      }, cfg.requestTimeoutMs);
      if (!detailResponse.ok) throw new Error(`official news detail ${link.newsId} HTTP ${detailResponse.status}`);
      const detailHtml = await detailResponse.text();
      const title = articleTitle(detailHtml, link.listTitle);
      const text = articleContent(detailHtml, title);
      if (!/station\s*head/i.test(text)) continue;

      const date = publishedDate(text);
      const year = Number(date?.slice(0, 4)) || new Date(now + 9 * 3600000).getUTCFullYear();
      const times = scheduleTimes(text, year);
      const article = {
        ...link,
        title,
        publishedDate: date,
        eventName: eventName(title),
        text,
      };

      if (!times.length) {
        await saveAnnouncement(env, article, null, now);
        console.warn(JSON.stringify({ event: 'official_news_time_unknown', news_id: link.newsId, title }));
      } else {
        for (const scheduledAt of times) {
          await saveAnnouncement(env, article, scheduledAt, now);
          console.log(JSON.stringify({
            event: 'official_news_announcement_saved',
            news_id: link.newsId,
            scheduled_at: scheduledAt,
            title,
          }));
        }
      }
    }

    await saveMonitorState(env, { lastCheckAt: now, lastSuccessAt: now, lastError: null });
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1000);
    await saveMonitorState(env, { lastCheckAt: now, lastSuccessAt: state?.last_success_at, lastError: message }).catch(() => {});
    console.error(JSON.stringify({ event: 'official_news_check_failed', error: message }));
  }
}

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

function normalizeComments(payload) {
  const candidates = [payload, payload?.items, payload?.data?.items, payload?.chats?.items, payload?.chats];
  const items = candidates.find(Array.isArray) || [];
  return items.map((chat) => ({
    commentId: finite(chat?.id),
    accountId: finite(chat?.account_id ?? chat?.account?.id),
    handle: chat?.account?.handle || null,
    text: chat?.text || null,
    chatTime: finite(chat?.chat_time),
    chatTimeMs: finite(chat?.chat_time_ms),
    raw: chat,
  })).filter((comment) => comment.commentId != null);
}

async function fetchComments(stationId, cfg, session) {
  for (const limit of [50, 20]) {
    try {
      return normalizeComments(await stationRequest(`/station/${stationId}/chatHistory?limit=${limit}`, cfg, session));
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

async function probeAnnouncements(env, cfg, now) {
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

async function runOfficialNewsMonitor(env) {
  if (!env.DB) return;
  const cfg = config(env);
  const now = Date.now();
  try {
    await checkOfficialNews(env, cfg, now);
    await probeAnnouncements(env, cfg, now);
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1000);
    console.error(JSON.stringify({ event: 'official_news_monitor_failed', error: message }));
  }
}

export const OFFICIAL_HEALTH_SQL = `SELECT
  monitor.last_check_at,monitor.last_success_at,monitor.last_error,
  (SELECT COUNT(*) FROM sh_official_news_announcements
    WHERE status='scheduled' AND scheduled_at>=?) AS upcoming_count,
  (SELECT COUNT(*) FROM sh_official_news_announcements
    WHERE status='active') AS active_count
FROM (SELECT ? AS id) requested
LEFT JOIN sh_official_news_monitor_state monitor ON monitor.id=requested.id`;

export async function loadOfficialHealthState(env, now = Date.now()) {
  return env.DB.prepare(OFFICIAL_HEALTH_SQL).bind(now, STATE_ID).first();
}

async function health(env, baseResponse) {
  const base = await baseResponse.json().catch(() => ({}));
  try {
    const state = await loadOfficialHealthState(env);
    return new Response(JSON.stringify({
      ...base,
      official_news_last_check_at: finite(state?.last_check_at),
      official_news_last_success_at: finite(state?.last_success_at),
      official_news_last_error: state?.last_error || null,
      official_news_upcoming_count: Number(state?.upcoming_count || 0),
      official_news_active_count: Number(state?.active_count || 0),
    }), {
      status: baseResponse.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  } catch {
    return new Response(JSON.stringify({ ...base, official_news_setup_required: true }), {
      status: baseResponse.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
}

export default {
  async scheduled(controller, env, ctx) {
    await app.scheduled(controller, env, ctx);
    ctx.waitUntil(runOfficialNewsMonitor(env));
  },

  async fetch(request, env, ctx) {
    const response = await app.fetch(request, env, ctx);
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return health(env, response);
    }
    return response;
  },
};
