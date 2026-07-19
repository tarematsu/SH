import {
  markMissedAnnouncements,
  monitorState,
  saveAnnouncement,
  saveMonitorState,
} from './official-news-announcements.js';
import {
  articleContent,
  articleLinks,
  articleTitle,
  eventName,
  publishedDate,
  scheduleTimes,
} from './official-news-html.js';
import {
  NEWS_LIST_URL,
  timedFetch,
} from './official-news-utils.js';

const NEWS_HEADERS = Object.freeze({
  accept: 'text/html,application/xhtml+xml',
  'user-agent': 'stationhead-monitor/1.0',
});

function compactCandidate(link) {
  return {
    newsId: String(link?.newsId || '').slice(0, 100),
    href: String(link?.href || '').slice(0, 1000),
    listTitle: String(link?.listTitle || '').slice(0, 500),
  };
}

async function recordFailure(env, now, error, dependencies, event) {
  const readState = dependencies.monitorState || monitorState;
  const writeState = dependencies.saveMonitorState || saveMonitorState;
  const state = await readState(env).catch(() => null);
  const message = String(error?.message || error).slice(0, 1000);
  await writeState(env, {
    lastCheckAt: now,
    lastSuccessAt: state?.last_success_at,
    lastError: message,
  }).catch(() => {});
  console.error(JSON.stringify({ event, error: message }));
  return { skipped: true, failed: true, reason: event };
}

export async function runOfficialNewsListStage(env, cfg, now, dependencies = {}) {
  const readState = dependencies.monitorState || monitorState;
  const markMissed = dependencies.markMissedAnnouncements || markMissedAnnouncements;
  const fetchImpl = dependencies.fetch || timedFetch;
  const parseLinks = dependencies.articleLinks || articleLinks;
  const state = await readState(env);
  if (Number(state?.last_check_at || 0)
      && now - Number(state.last_check_at) < cfg.checkIntervalMs) {
    return { skipped: true, failed: false, reason: 'not-due', candidates: [] };
  }

  await markMissed(env, cfg, now);
  try {
    const response = await fetchImpl(NEWS_LIST_URL, {
      headers: NEWS_HEADERS,
      cf: { cacheEverything: true, cacheTtl: Math.floor(cfg.checkIntervalMs / 1000) },
    }, cfg.requestTimeoutMs);
    if (!response.ok) throw new Error(`official news list HTTP ${response.status}`);
    const html = await response.text();
    const links = parseLinks(html, cfg.articleLimit);
    const candidates = links
      .filter((link, index) => index < cfg.bodyScanCount || /station\s*head/i.test(link.listTitle))
      .map(compactCandidate)
      .filter((link) => link.newsId && link.href);
    return { skipped: false, failed: false, reason: null, candidates };
  } catch (error) {
    return recordFailure(env, now, error, dependencies, 'official_news_list_failed');
  }
}

export async function runOfficialNewsDetailStage(env, cfg, now, candidate, dependencies = {}) {
  const fetchImpl = dependencies.fetch || timedFetch;
  const parseTitle = dependencies.articleTitle || articleTitle;
  const parseContent = dependencies.articleContent || articleContent;
  const parsePublishedDate = dependencies.publishedDate || publishedDate;
  const parseScheduleTimes = dependencies.scheduleTimes || scheduleTimes;
  const parseEventName = dependencies.eventName || eventName;
  const save = dependencies.saveAnnouncement || saveAnnouncement;
  try {
    const response = await fetchImpl(candidate.href, {
      headers: NEWS_HEADERS,
      cf: { cacheEverything: true, cacheTtl: Math.floor(cfg.checkIntervalMs / 1000) },
    }, cfg.requestTimeoutMs);
    if (!response.ok) throw new Error(`official news detail ${candidate.newsId} HTTP ${response.status}`);
    const detailHtml = await response.text();
    const title = parseTitle(detailHtml, candidate.listTitle);
    const text = parseContent(detailHtml, title);
    if (!/station\s*head/i.test(text)) {
      return { skipped: true, failed: false, reason: 'not-stationhead', saved: 0 };
    }

    const date = parsePublishedDate(text);
    const year = Number(date?.slice(0, 4)) || new Date(now + 9 * 3600000).getUTCFullYear();
    const times = parseScheduleTimes(text, year);
    const article = {
      ...candidate,
      title,
      publishedDate: date,
      eventName: parseEventName(title),
      text,
    };

    if (!times.length) {
      await save(env, article, null, now);
      console.warn(JSON.stringify({
        event: 'official_news_time_unknown',
        news_id: candidate.newsId,
        title,
      }));
      return { skipped: false, failed: false, reason: null, saved: 1 };
    }

    for (const scheduledAt of times) {
      await save(env, article, scheduledAt, now);
      console.log(JSON.stringify({
        event: 'official_news_announcement_saved',
        news_id: candidate.newsId,
        scheduled_at: scheduledAt,
        title,
      }));
    }
    return { skipped: false, failed: false, reason: null, saved: times.length };
  } catch (error) {
    return recordFailure(env, now, error, dependencies, 'official_news_detail_failed');
  }
}

export async function completeOfficialNewsCheck(env, now, dependencies = {}) {
  const writeState = dependencies.saveMonitorState || saveMonitorState;
  await writeState(env, { lastCheckAt: now, lastSuccessAt: now, lastError: null });
  return { skipped: false, failed: false, reason: null };
}
