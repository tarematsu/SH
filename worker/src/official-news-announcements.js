import {
  NEWS_LIST_URL,
  OFFICIAL_NEWS_STATE_ID,
  timedFetch,
} from './official-news-utils.js';
import {
  articleContent,
  articleLinks,
  articleTitle,
  eventName,
  publishedDate,
  scheduleTimes,
} from './official-news-html.js';

export async function monitorState(env) {
  return env.DB.prepare(`SELECT last_check_at,last_success_at,last_error FROM sh_official_news_monitor_state WHERE id=?`)
    .bind(OFFICIAL_NEWS_STATE_ID).first();
}

export async function saveMonitorState(env, values) {
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO sh_official_news_monitor_state
      (id,last_check_at,last_success_at,last_error,updated_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        last_check_at=excluded.last_check_at,
        last_success_at=excluded.last_success_at,
        last_error=excluded.last_error,
        updated_at=excluded.updated_at`)
    .bind(OFFICIAL_NEWS_STATE_ID, values.lastCheckAt ?? now, values.lastSuccessAt ?? null, values.lastError ?? null, now).run();
}

export async function saveAnnouncement(env, article, scheduledAt, detectedAt) {
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

export async function markMissedAnnouncements(env, cfg, now) {
  await env.DB.prepare(`UPDATE sh_official_news_announcements SET status='missed',updated_at=?
    WHERE status='scheduled' AND scheduled_at IS NOT NULL AND scheduled_at<?`)
    .bind(now, now - cfg.lateWindowMs).run();
}

export async function checkOfficialNews(env, cfg, now) {
  const state = await monitorState(env);
  if (Number(state?.last_check_at || 0) && now - Number(state.last_check_at) < cfg.checkIntervalMs) return;
  await saveMonitorState(env, { lastCheckAt: now, lastSuccessAt: state?.last_success_at, lastError: null });
  await markMissedAnnouncements(env, cfg, now);

  try {
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
