export const API_CONTRACT_VERSION = 3;

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

export const COMPATIBILITY_ENDPOINTS = Object.freeze([
  {
    path: '/api/health/collector',
    successor: '/api/health',
    behavior: 'redirect',
    status: 308,
    description: 'Explicit compatibility alias for primary collector health',
  },
  {
    path: '/api/history-current',
    successor: '/api/minute-facts/current',
    behavior: 'redirect',
    status: 308,
    description: 'Compatibility alias for the current minute-facts view',
  },
  {
    path: '/api/history-migrated',
    successor: '/api/minute-facts',
    behavior: 'redirect',
    status: 308,
    description: 'Compatibility alias for paginated minute facts',
  },
  {
    path: '/api/history-raw',
    successor: '/api/history?mode=raw',
    behavior: 'response',
    status: 200,
    description: 'Compatibility route for legacy-source raw history',
  },
  {
    path: '/api/official-history',
    successor: '/api/history?mode=broadcasts',
    behavior: 'response',
    status: 200,
    description: 'Compatibility route for official broadcast summaries',
  },
]);

export const RETIRED_ENDPOINTS = Object.freeze([
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

export const API_SUCCESSORS = Object.freeze(Object.fromEntries(
  COMPATIBILITY_ENDPOINTS.map(({ path, successor }) => [path, successor]),
));

export function canonicalApiPaths() {
  return Object.values(API_GROUPS).flat().map(({ path }) => path);
}
