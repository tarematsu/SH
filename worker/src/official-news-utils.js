import {
  finiteNumber,
  positiveNumber as positive,
  timedFetch,
} from './shared.js';

export const NEWS_LIST_URL = 'https://sakurazaka46.com/s/s46/news/list';
export const NEWS_ORIGIN = 'https://sakurazaka46.com';
export const SH_ORIGIN = 'https://production1.stationhead.com';
export const OFFICIAL_NEWS_STATE_ID = 'official-news';
export const finite = finiteNumber;
export { timedFetch };

export function officialNewsConfig(env) {
  return {
    checkIntervalMs: positive(env.OFFICIAL_NEWS_CHECK_INTERVAL_MS, 30 * 60 * 1000),
    earlyWindowMs: positive(env.OFFICIAL_NEWS_EARLY_WINDOW_MS, 5 * 60 * 1000),
    lateWindowMs: positive(env.OFFICIAL_NEWS_LATE_WINDOW_MS, 90 * 60 * 1000),
    endConfirmPolls: positive(env.OFFICIAL_NEWS_END_CONFIRM_POLLS, 5),
    articleLimit: Math.min(positive(env.OFFICIAL_NEWS_ARTICLE_LIMIT, 20), 40),
    bodyScanCount: Math.min(positive(env.OFFICIAL_NEWS_BODY_SCAN_COUNT, 5), 10),
    handle: env.OFFICIAL_NEWS_STATIONHEAD_HANDLE || env.OFFICIAL_NEWS_SH_HANDLE || 'sakurazaka46jp',
    appVersion: env.STATIONHEAD_APP_VERSION || env.SH_APP_VERSION || '1.0.0',
    requestTimeoutMs: Math.min(positive(env.REQUEST_TIMEOUT_MS, 20_000), 30_000),
  };
}
