import app from './optimized-index.js';
import { officialNewsHealth } from './official-news-health.js';

export {
  checkOfficialNews,
  markMissedAnnouncements,
  monitorState,
  saveAnnouncement,
  saveMonitorState,
} from './official-news-announcements.js';
export {
  articleContent,
  articleLinks,
  articleTitle,
  decodeHtml,
  eventName,
  jstTimestamp,
  publishedDate,
  scheduleTimes,
  stripHtml,
} from './official-news-html.js';
export {
  OFFICIAL_HEALTH_SQL,
  loadOfficialHealthState,
  officialNewsHealth,
} from './official-news-health.js';
export {
  OFFICIAL_PROBE_CONTEXT_SQL,
  compactProbePayload,
  loadOfficialProbeContext,
  officialCommentWriteCounts,
  officialCommentsToWrite,
  probeAnnouncements,
  runOfficialNewsMonitor,
} from './official-news-probe.js';
export {
  NEWS_LIST_URL,
  NEWS_ORIGIN,
  OFFICIAL_NEWS_STATE_ID,
  SH_ORIGIN,
  finite,
  officialNewsConfig,
  timedFetch,
} from './official-news-utils.js';

// Official news monitoring + reconciliation now runs on the "other" worker's
// own cron (see other-entry.js); the buddies worker must not duplicate it.
export default {
  async scheduled(controller, env, ctx) {
    await app.scheduled(controller, env, ctx);
  },

  async fetch(request, env, ctx) {
    const response = await app.fetch(request, env, ctx);
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return officialNewsHealth(env, response);
    }
    return response;
  },
};
