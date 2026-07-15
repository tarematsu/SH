const API_GROUPS = Object.freeze({
  status: [
    { path: '/api/health', methods: ['GET'], description: 'Primary collector health summary' },
    { path: '/api/health/collector', methods: ['GET'], description: 'Primary collector health alias' },
    { path: '/api/health/minute', methods: ['GET'], description: 'Minute pipeline task health' },
    { path: '/api/health/other', methods: ['GET'], description: 'Other worker scheduler and source health' },
    { path: '/api/minute-facts/latest', methods: ['GET'], description: 'Latest five minute facts and freshness status' },
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
  history: [
    { path: '/api/history', methods: ['GET'], description: 'Normalized history views' },
    { path: '/api/history-raw', methods: ['GET'], description: 'Cursor-based raw minute history' },
    { path: '/api/history-migrated', methods: ['GET'], description: 'Migrated history compatibility view' },
    { path: '/api/official-history', methods: ['GET'], description: 'Official stream history' },
    { path: '/api/host-history', methods: ['GET'], description: 'Host history' },
    { path: '/api/broadcast-series', methods: ['GET'], description: 'Broadcast time series' },
  ],
  ingest: [
    { path: '/api/ingest', methods: ['POST'], description: 'Authenticated ingestion endpoint' },
    { path: '/api/host-ingest', methods: ['POST'], description: 'Authenticated host ingestion endpoint' },
  ],
});

export function apiCatalog(now = Date.now()) {
  return {
    ok: true,
    service: 'stationhead-pages-api',
    gateway: 'cloudflare-pages',
    worker_urls_public: false,
    generated_at: now,
    generated_at_iso: new Date(now).toISOString(),
    groups: API_GROUPS,
  };
}

export async function onRequestGet() {
  return Response.json(apiCatalog(), {
    headers: {
      'cache-control': 'public, max-age=300, s-maxage=3600',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function onRequest() {
  return Response.json({ ok: false, error: 'method-not-allowed' }, {
    status: 405,
    headers: { allow: 'GET' },
  });
}
