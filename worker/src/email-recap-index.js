import app from './official-news-index.js';
import { enhancedHealth } from './collector-health-enrichment.js';
import {
  COLLECTOR_LEASE_PATH,
  collectorLeaseCoordination,
  renewCollectorLease,
} from './collector-failover-lease.js';
import { ingestEmailRecap } from './email-recap-ingest.js';
import { EMAIL_RECAP_PATH } from './email-recap-utils.js';

export { enhancedHealth } from './collector-health-enrichment.js';
export { EMAIL_RECAP_UPSERT_SQL, ingestEmailRecap } from './email-recap-ingest.js';
export {
  COLLECTOR_LEASE_PATH,
  COLLECTOR_LEASE_SCOPE,
  COLLECTOR_LEASE_TTL_MS,
  collectorLeaseCoordination,
  readCollectorLease,
  renewCollectorLease,
} from './collector-failover-lease.js';
export {
  EMAIL_SERIES_CONTEXT_SQL,
  assess,
  assessEmailSeries,
  loadEmailSeriesContext,
  loadReferencePoints,
} from './email-recap-validation.js';
export {
  DEFAULT_EMAIL_RECAP_OFFSET_MINUTES,
  EMAIL_RECAP_PATH,
  addDays,
  authorized,
  finite,
  json,
  jstDate,
  median,
  validDate,
  weeksBetween,
} from './email-recap-utils.js';

export default {
  async scheduled(controller, env, ctx) {
    await renewCollectorLease(env).catch((error) => {
      console.error(JSON.stringify({ event: 'collector_lease_failed', error: String(error?.message || error) }));
    });
    // Cloud host monitoring now runs exclusively on the "other" worker's own
    // cron (see other-entry.js); the buddies worker must not duplicate it.
    return app.scheduled(controller, env, ctx);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === COLLECTOR_LEASE_PATH) return collectorLeaseCoordination(env);
    if (request.method === 'POST' && url.pathname === EMAIL_RECAP_PATH) return ingestEmailRecap(request, env);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return enhancedHealth(app, request, env, ctx);
    }
    return app.fetch(request, env, ctx);
  },
};
