import app from './official-news-index.js';
import { runCloudHostMonitor } from './cloud-host-monitor.js';
import { enhancedHealth } from './email-recap-health.js';
import { ingestEmailRecap } from './email-recap-ingest.js';
import { coordination, renewCloudLease } from './email-recap-lease.js';
import { EMAIL_RECAP_LEASE_PATH, EMAIL_RECAP_PATH } from './email-recap-utils.js';

export { enhancedHealth } from './email-recap-health.js';
export { EMAIL_RECAP_UPSERT_SQL, ingestEmailRecap } from './email-recap-ingest.js';
export {
  EMAIL_RECAP_LEASE_SCOPE,
  EMAIL_RECAP_LEASE_TTL_MS,
  coordination,
  readCloudLease,
  renewCloudLease,
} from './email-recap-lease.js';
export {
  EMAIL_SERIES_CONTEXT_SQL,
  assess,
  assessEmailSeries,
  loadEmailSeriesContext,
  loadReferencePoints,
} from './email-recap-validation.js';
export {
  DEFAULT_EMAIL_RECAP_OFFSET_MINUTES,
  EMAIL_RECAP_LEASE_PATH,
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
    await renewCloudLease(env).catch((error) => {
      console.error(JSON.stringify({ event: 'collector_lease_failed', error: String(error?.message || error) }));
    });
    await app.scheduled(controller, env, ctx);
    ctx.waitUntil(runCloudHostMonitor(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === EMAIL_RECAP_LEASE_PATH) return coordination(env);
    if (request.method === 'POST' && url.pathname === EMAIL_RECAP_PATH) return ingestEmailRecap(request, env);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return enhancedHealth(app, request, env, ctx);
    }
    return app.fetch(request, env, ctx);
  },
};
