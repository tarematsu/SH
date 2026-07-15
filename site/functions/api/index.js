const API_GROUPS = Object.freeze({
  status: [
    { path: '/api/health', methods: ['GET'], description: 'Primary collector health summary' },
    { path: '/api/health/collector', methods: ['GET'], description: 'Explicit primary collector health route' },
    { path: '/api/health/minute', methods: ['GET'], description: 'Minute pipeline task health' },
    { path: '/api/health/other', methods: ['GET'], description: 'Other worker scheduler and source health' },
  ],
  dashboard: [
    { path: '/api/dashboard', methods: ['GET'], description: 'Current dashboard read model' },
    { path: '/api/dashboard-history', methods: ['GET'], description: 'Recent dashboard history' },
    { path: '/api/dashboard-queue', methods: ['GET'], description: 'Current queue read model' },
    { path: '/api/dashboard-recovery', methods: ['GET'], description: 'Dashboard recovery payload' },
    { path: '/api/playback', methods: ['GET'], description: 'Current playback state' },
    { path: '/api/comment-velocity', methods: ['GET'], description: 'Comment velocity series' },
    { path: '/api/track-likes', methods: ['GET'], description: 'Track like observations' },
    { path: '/api/like-ranking', methods: ['GET'], description: 'Track like ranking' },
  ],
  minute_facts: [
    { path: '/api/minute-facts', methods: ['GET'], description: 'Filtered and cursor-paginated minute facts' },
    { path: '/api/minute-facts/current', methods: ['GET'], description: 'Latest 1440 minute facts for current history views' },
    { path: '/api/minute-facts/latest', methods: ['GET'], description: 'Latest five minute facts and freshness status' },
  ],
  history: [
    { path: '/api/history', methods: ['GET'], description: 'Daily, weekly, monthly, ranking, broadcast, and raw history modes' },
    { path: '/api/track-history', methods: ['GET'], description: 'Track play history' },
    { path: '/api/broadcast-series', methods: ['GET'], description: 'Broadcast listener time series' },
    { path: '/api/host-history', methods: ['GET'], description: 'Host profiles, sessions, and session details' },
  ],
});

const COMPATIBILITY_ENDPOINTS = Object.freeze([
  {
    path: '/api/history-current',
    successor: '/api/minute-facts/current',
    description: 'Compatibility alias for the current minute-facts view',
  },
  {
    path: '/api/history-migrated',
    successor: '/api/minute-facts',
    description: 'Compatibility alias for paginated minute facts',
  },
  {
    path: '/api/history-raw',
    successor: '/api/history?mode=raw',
    description: 'Compatibility route for legacy-source raw history',
  },
  {
    path: '/api/official-history',
    successor: '/api/history?mode=broadcasts',
    description: 'Compatibility route for official broadcast summaries',
  },
]);

const RETIRED_ENDPOINTS = Object.freeze([
  { path: '/api/ingest', status: 404, description: 'Public Pages ingestion is disabled' },
  { path: '/api/host-ingest', status: 404, description: 'Public Pages host ingestion is disabled' },
]);

export function apiCatalog(now = Date.now()) {
  return {
    ok: true,
    service: 'stationhead-pages-api',
    gateway: 'cloudflare-pages',
    worker_urls_public: false,
    public_write_api: false,
    generated_at: now,
    generated_at_iso: new Date(now).toISOString(),
    groups: API_GROUPS,
    compatibility: COMPATIBILITY_ENDPOINTS,
    retired: RETIRED_ENDPOINTS,
  };
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return Response.json({ ok: false, error: 'method-not-allowed' }, {
      status: 405,
      headers: { allow: 'GET' },
    });
  }
  return Response.json(apiCatalog(), {
    headers: {
      'cache-control': 'public, max-age=300, s-maxage=3600',
      'x-content-type-options': 'nosniff',
    },
  });
}
