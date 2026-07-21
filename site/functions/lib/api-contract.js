export const API_CONTRACT_VERSION = 3;

export const API_GROUPS = Object.freeze({
  status: Object.freeze([
    { path: '/api/health', methods: ['GET'], description: 'Primary collector health summary' },
    { path: '/api/health/minute', methods: ['GET'], description: 'Minute pipeline task health' },
    { path: '/api/health/other', methods: ['GET'], description: 'Runtime scheduler health' },
    { path: '/api/health/sakurazaka46jp', methods: ['GET'], description: 'Sakurazaka monitor and official-news health' },
  ]),
  dashboard: Object.freeze([
    { path: '/api/dashboard', methods: ['GET'], description: 'Current state, queue, recent history, and completed daily changes' },
  ]),
  history: Object.freeze([
    { path: '/api/history', methods: ['GET'], description: 'Daily, weekly, monthly, ranking, and broadcast history modes' },
    { path: '/api/track-history', methods: ['GET'], description: 'Track play history with like ranking' },
    { path: '/api/sakurazaka46jp', methods: ['GET'], description: 'Sakurazaka official broadcast listener series' },
    { path: '/api/host-history', methods: ['GET'], description: 'Sakurazaka broadcast sessions and session details' },
  ]),
});

export const INTERNAL_API_PATHS = Object.freeze([
  '/api/history-legacy',
  '/api/ingest',
  '/api/ingest-core',
  '/api/ingest-legacy',
  '/api/host-ingest',
  '/api/host-ingest-core',
  '/api/host-ingest-legacy',
]);

const blockedApiPaths = new Set(INTERNAL_API_PATHS);

export const API_EDGE_TTL_SECONDS = 300;
export const API_BROWSER_TTL_SECONDS = 30;
export const MATERIALIZED_RESPONSE_MAX_AGE_MS = 15 * 60_000;

export const MATERIALIZED_API_VARIANTS = Object.freeze([
  Object.freeze({ key: 'history:daily', url: '/api/history?mode=daily', cadence_minutes: 360 }),
  Object.freeze({ key: 'history:weekly', url: '/api/history?mode=weekly', cadence_minutes: 360 }),
  Object.freeze({ key: 'history:monthly', url: '/api/history?mode=monthly', cadence_minutes: 360 }),
  Object.freeze({ key: 'history:broadcasts', url: '/api/history?mode=broadcasts', cadence_minutes: 360 }),
  Object.freeze({ key: 'track-history', url: '/api/track-history', cadence_minutes: 360 }),
  Object.freeze({ key: 'host-history:summary', url: '/api/host-history?mode=summary', cadence_minutes: 1440 }),
]);

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

export function materializedApiKey(input) {
  const url = input instanceof URL ? input : new URL(input);
  const pathname = normalizedPathname(url.pathname);

  if (pathname === '/api/dashboard' && onlyParameters(url, ['history', 'since', 'queue_revision'])) return 'dashboard';
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
  return true;
}

export function apiCacheTtlSeconds() {
  return API_EDGE_TTL_SECONDS;
}

export function materializedResponseCadenceSeconds(modelKey) {
  const cadenceMinutes = Number(materializedVariantsByKey.get(String(modelKey || ''))?.cadence_minutes);
  if (!Number.isFinite(cadenceMinutes) || cadenceMinutes <= 0) return API_EDGE_TTL_SECONDS;
  return Math.max(API_EDGE_TTL_SECONDS, Math.trunc(cadenceMinutes * 60));
}

export function materializedResponseMaximumAge(modelKey, env = {}) {
  const configured = Number(env.PAGES_RESPONSE_MAX_AGE_MS);
  const cadenceMs = materializedResponseCadenceSeconds(modelKey) * 1000;
  const graceMs = API_EDGE_TTL_SECONDS * 1000;
  const minimum = cadenceMs + graceMs;
  const fallback = Math.max(MATERIALIZED_RESPONSE_MAX_AGE_MS, minimum);
  return Number.isFinite(configured) && configured >= minimum ? configured : fallback;
}

export function canonicalApiCacheRequest(request) {
  const url = new URL(request.url);
  const pathname = normalizedPathname(url.pathname);
  url.searchParams.delete('v');

  if (pathname === '/api/history'
      && String(url.searchParams.get('mode') || 'weekly').trim().toLowerCase() === 'weekly') {
    url.searchParams.delete('mode');
  }
  if (pathname === '/api/host-history'
      && String(url.searchParams.get('mode') || 'summary').trim().toLowerCase() === 'summary') {
    url.searchParams.delete('mode');
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
