const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MIN_TTL_MS = 10 * 1000;
const MAX_TTL_MS = 15 * 60 * 1000;

const PRIVATE_HEALTH_FIELDS = new Set([
  'configured',
  'last_error',
  'auth_last_error',
  'browser_last_auth_error',
  'official_news_last_error',
  'cloud_host_last_error',
  'collector_health_error',
  'token_expires_at',
  'auth_token_expires_at',
  'browser_token_expires_at',
  'channel_id',
  'station_id',
  'cloud_solo_session_id',
  'cloud_solo_station_id',
]);

function ttlMs(env = {}) {
  const configured = Number(env.PUBLIC_HEALTH_CACHE_MS ?? DEFAULT_TTL_MS);
  if (!Number.isFinite(configured)) return DEFAULT_TTL_MS;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, configured));
}

export function sanitizePublicHealth(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const sanitized = { ...payload };
  for (const field of PRIVATE_HEALTH_FIELDS) delete sanitized[field];
  return sanitized;
}

function responseFromEntry(entry, cacheStatus) {
  const headers = new Headers(entry.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set(
    'cache-control',
    entry.status >= 500 ? 'no-store' : 'public, max-age=30, stale-while-revalidate=30',
  );
  headers.set('x-health-cache', cacheStatus);
  return new Response(entry.body, { status: entry.status, headers });
}

async function buildEntry(app, request, env, ctx) {
  const response = await app.fetch(request, env, ctx);
  const payload = await response.clone().json().catch(() => null);
  if (!payload) return { response, entry: null };
  const entry = {
    status: response.status,
    headers: [...response.headers.entries()],
    body: JSON.stringify(sanitizePublicHealth(payload)),
  };
  return { response: responseFromEntry(entry, 'miss'), entry };
}

export function createPublicHealthCachedApp(app, nowFn = Date.now) {
  let cached = null;
  let cacheEpoch = 0;
  let latestBuildId = 0;

  function invalidate() {
    cached = null;
    cacheEpoch += 1;
  }

  return {
    async scheduled(controller, env, ctx) {
      try {
        return await app.scheduled(controller, env, ctx);
      } finally {
        invalidate();
      }
    },

    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const isHealth = request.method === 'GET'
        && (url.pathname === '/' || url.pathname === '/health');
      if (!isHealth) {
        const response = await app.fetch(request, env, ctx);
        if (request.method !== 'GET' && response.status < 500) invalidate();
        return response;
      }

      const now = Number(nowFn()) || Date.now();
      if (cached && cached.expiresAt > now) return responseFromEntry(cached, 'hit');
      const startedEpoch = cacheEpoch;
      const buildId = ++latestBuildId;
      const { response, entry } = await buildEntry(app, request, env, ctx);
      if (entry
        && entry.status < 500
        && startedEpoch === cacheEpoch
        && buildId === latestBuildId) {
        cached = { ...entry, expiresAt: now + ttlMs(env) };
      }
      return entry ? responseFromEntry(entry, 'miss') : response;
    },

    invalidateHealthCache: invalidate,
  };
}
