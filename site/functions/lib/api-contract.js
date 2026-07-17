export const API_CONTRACT_VERSION = 2;

export const API_GROUPS = Object.freeze({
  status: Object.freeze([
    { path: '/api/health', methods: ['GET'], description: 'Primary collector health summary' },
    { path: '/api/health/minute', methods: ['GET'], description: 'Minute pipeline task health' },
    { path: '/api/health/other', methods: ['GET'], description: 'Other worker scheduler and source health' },
  ]),
  dashboard: Object.freeze([
    { path: '/api/dashboard', methods: ['GET'], description: 'Current dashboard read model' },
    { path: '/api/dashboard-history', methods: ['GET'], description: 'Recent dashboard history' },
    { path: '/api/dashboard-queue', methods: ['GET'], description: 'Current queue read model' },
    { path: '/api/dashboard-recovery', methods: ['GET'], description: 'Dashboard recovery payload' },
    { path: '/api/playback', methods: ['GET'], description: 'Current playback state' },
    { path: '/api/comment-velocity', methods: ['GET'], description: 'Comment velocity series' },
    { path: '/api/track-likes', methods: ['GET'], description: 'Track like observations' },
    { path: '/api/like-ranking', methods: ['GET'], description: 'Track like ranking' },
  ]),
  minute_facts: Object.freeze([
    { path: '/api/minute-facts', methods: ['GET'], description: 'Filtered and cursor-paginated minute facts' },
    { path: '/api/minute-facts/current', methods: ['GET'], description: 'Latest 1440 minute facts for current history views' },
    { path: '/api/minute-facts/latest', methods: ['GET'], description: 'Latest five minute facts and freshness status' },
  ]),
  history: Object.freeze([
    { path: '/api/history', methods: ['GET'], description: 'Daily, weekly, monthly, ranking, broadcast, and raw history modes' },
    { path: '/api/track-history', methods: ['GET'], description: 'Track play history' },
    { path: '/api/broadcast-series', methods: ['GET'], description: 'Broadcast listener time series' },
    { path: '/api/host-history', methods: ['GET'], description: 'Host profiles, sessions, and session details' },
  ]),
});

export const RETIRED_ENDPOINTS = Object.freeze([
  { path: '/api/health/collector', status: 404, description: 'Use /api/health' },
  { path: '/api/history-current', status: 404, description: 'Use /api/minute-facts/current' },
  { path: '/api/history-migrated', status: 404, description: 'Use /api/minute-facts' },
  { path: '/api/history-raw', status: 404, description: 'Use /api/history?mode=raw' },
  { path: '/api/official-history', status: 404, description: 'Use /api/history?mode=broadcasts' },
  { path: '/api/ingest', status: 404, description: 'Public Pages ingestion is disabled' },
  { path: '/api/host-ingest', status: 404, description: 'Public Pages host ingestion is disabled' },
]);

export const INTERNAL_API_PATHS = Object.freeze([
  '/api/dashboard-legacy',
  '/api/history-legacy',
  '/api/ingest-core',
  '/api/ingest-legacy',
  '/api/host-ingest-core',
  '/api/host-ingest-legacy',
]);

export const BLOCKED_API_PATHS = Object.freeze([
  ...RETIRED_ENDPOINTS.map(({ path }) => path),
  ...INTERNAL_API_PATHS,
]);

export const API_EDGE_TTL_SECONDS = 300;
export const PLAYBACK_EDGE_TTL_SECONDS = 300;
export const API_BROWSER_TTL_SECONDS = 30;
export const MATERIALIZED_RESPONSE_MAX_AGE_MS = 15 * 60_000;
export const PLAYBACK_RESPONSE_MAX_AGE_MS = 2 * 60 * 60_000;

export const MATERIALIZED_API_VARIANTS = Object.freeze([
  Object.freeze({ key: 'dashboard-history', url: '/api/dashboard-history', cadence_minutes: 360 }),
  Object.freeze({ key: 'track-likes', url: '/api/track-likes', cadence_minutes: 360 }),
  Object.freeze({ key: 'like-ranking', url: '/api/like-ranking', cadence_minutes: 360 }),
  Object.freeze({ key: 'minute-facts-current', url: '/api/minute-facts/current', cadence_minutes: 360 }),
  Object.freeze({ key: 'history:daily', url: '/api/history?mode=daily', cadence_minutes: 360 }),
  Object.freeze({ key: 'history:weekly', url: '/api/history?mode=weekly', cadence_minutes: 360 }),
  Object.freeze({ key: 'history:monthly', url: '/api/history?mode=monthly', cadence_minutes: 360 }),
  Object.freeze({ key: 'history:broadcasts', url: '/api/history?mode=broadcasts', cadence_minutes: 360 }),
  Object.freeze({ key: 'track-history', url: '/api/track-history', cadence_minutes: 360 }),
  Object.freeze({ key: 'host-history:summary', url: '/api/host-history?mode=summary', cadence_minutes: 1440 }),
]);

const blockedApiPaths = new Set(BLOCKED_API_PATHS);
const materializedVariantsByKey = new Map(MATERIALIZED_API_VARIANTS.map((variant) => [variant.key, variant]));

function normalizedPathname(value) {
  const pathname = String(value || '/');
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

function onlyParameters(url, allowed = []) {
  const keys = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (key !== 'v' && !keys.has(key)) return false;
  }
  return true;
}

function normalizedChannel(url) {
  return String(url.searchParams.get('channel') || 'buddies').trim().toLowerCase();
}

export function materializedApiKey(input) {
  const url = input instanceof URL ? input : new URL(input);
  const pathname = normalizedPathname(url.pathname);

  if (pathname === '/api/playback') return null;
  if (pathname === '/api/dashboard' && onlyParameters(url)) return 'dashboard';
  if (pathname === '/api/dashboard-history' && onlyParameters(url)) return 'dashboard-history';
  if (pathname === '/api/dashboard-queue' && onlyParameters(url, ['offset', 'limit'])) {
    const offset = url.searchParams.get('offset');
    const limit = url.searchParams.get('limit');
    return (offset == null || Number(offset) === 11) && (limit == null || Number(limit) === 20)
      ? 'dashboard-queue'
      : null;
  }
  if (pathname === '/api/comment-velocity' && onlyParameters(url)) return 'comment-velocity';
  if (pathname === '/api/track-likes' && onlyParameters(url)) return 'track-likes';
  if (pathname === '/api/like-ranking' && onlyParameters(url, ['limit'])) {
    const limit = url.searchParams.get('limit');
    return limit == null || Number(limit) === 200 ? 'like-ranking' : null;
  }
  if (pathname === '/api/minute-facts/current' && onlyParameters(url)) return 'minute-facts-current';
  if (pathname === '/api/history' && onlyParameters(url, ['mode'])) {
    const mode = String(url.searchParams.get('mode') || 'weekly').trim().toLowerCase();
    return ['daily', 'weekly', 'monthly', 'broadcasts'].includes(mode) ? `history:${mode}` : null;
  }
  if (pathname === '/api/track-history' && onlyParameters(url)) return 'track-history';
  if (pathname === '/api/host-history' && onlyParameters(url, ['mode'])) {
    const mode = String(url.searchParams.get('mode') || 'summary').trim().toLowerCase();
    return mode === 'summary' ? 'host-history:summary' : null;
  }
  return null;
}

export function edgeCacheableApiRequest(request) {
  if (request.method !== 'GET' || request.headers.has('authorization')) return false;
  const url = new URL(request.url);
  const pathname = normalizedPathname(url.pathname);
  if (!pathname.startsWith('/api/') || blockedApiPaths.has(pathname)) return false;
  if (pathname.startsWith('/api/health')) return false;
  if (pathname === '/api/minute-facts/latest' || pathname === '/api/dashboard-recovery') return false;
  if (url.searchParams.has('raw') || url.searchParams.get('mode') === 'raw') return false;
  return true;
}

export function apiCacheTtlSeconds(request) {
  return normalizedPathname(new URL(request.url).pathname) === '/api/playback'
    ? PLAYBACK_EDGE_TTL_SECONDS
    : API_EDGE_TTL_SECONDS;
}

export function materializedResponseCadenceSeconds(modelKey) {
  if (String(modelKey || '').startsWith('playback:')) return PLAYBACK_EDGE_TTL_SECONDS;
  const cadenceMinutes = Number(materializedVariantsByKey.get(String(modelKey || ''))?.cadence_minutes);
  if (!Number.isFinite(cadenceMinutes) || cadenceMinutes <= 0) return API_EDGE_TTL_SECONDS;
  return Math.max(API_EDGE_TTL_SECONDS, Math.trunc(cadenceMinutes * 60));
}

export function materializedResponseMaximumAge(modelKey, env = {}) {
  const playback = String(modelKey || '').startsWith('playback:');
  const configured = Number(playback
    ? env.PLAYBACK_RESPONSE_MAX_AGE_MS
    : env.PAGES_RESPONSE_MAX_AGE_MS);
  const cadenceMs = materializedResponseCadenceSeconds(modelKey) * 1000;
  const graceMs = API_EDGE_TTL_SECONDS * 1000;
  const minimum = cadenceMs + graceMs;
  const fallback = playback
    ? PLAYBACK_RESPONSE_MAX_AGE_MS
    : Math.max(MATERIALIZED_RESPONSE_MAX_AGE_MS, minimum);
  return Number.isFinite(configured) && configured >= minimum ? configured : fallback;
}

export function canonicalApiCacheRequest(request) {
  const url = new URL(request.url);
  const pathname = normalizedPathname(url.pathname);
  url.searchParams.delete('v');

  if (pathname === '/api/playback' && normalizedChannel(url) === 'buddies') {
    url.searchParams.delete('channel');
  }
  if (pathname === '/api/history'
      && String(url.searchParams.get('mode') || 'weekly').trim().toLowerCase() === 'weekly') {
    url.searchParams.delete('mode');
  }
  if (pathname === '/api/host-history'
      && String(url.searchParams.get('mode') || 'summary').trim().toLowerCase() === 'summary') {
    url.searchParams.delete('mode');
  }
  if (pathname === '/api/dashboard-queue') {
    if (Number(url.searchParams.get('offset')) === 11) url.searchParams.delete('offset');
    if (Number(url.searchParams.get('limit')) === 20) url.searchParams.delete('limit');
  }
  if (pathname === '/api/like-ranking' && Number(url.searchParams.get('limit')) === 200) {
    url.searchParams.delete('limit');
  }

  const sorted = [...url.searchParams.entries()].sort(([aKey, aValue], [bKey, bValue]) =>
    aKey.localeCompare(bKey) || aValue.localeCompare(bValue));
  url.search = '';
  for (const [key, value] of sorted) url.searchParams.append(key, value);
  return new Request(url.toString(), {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
}

export function canonicalApiPaths() {
  return Object.values(API_GROUPS).flat().map(({ path }) => path);
}
