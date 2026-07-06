import app from './email-recap-index.js';
import { withD1WriteThrottling } from './main-d1-throttle.js';
import { rewriteHealthResponse } from './main-health.js';
import { expireLeaseWhenPrimaryFailed } from './main-lease.js';
import { runPrimaryScheduled } from './main-scheduler.js';

export { rewriteThrottledSql, withD1WriteThrottling } from './main-d1-throttle.js';
export { normalizeHealthPayload, rewriteHealthResponse } from './main-health.js';
export { expireLeaseWhenPrimaryFailed } from './main-lease.js';
export {
  PrimaryCollectionTimeoutError,
  resetPrimaryScheduledFlightForTests,
  runPrimaryScheduled,
} from './main-scheduler.js';

export default {
  async scheduled(controller, env, ctx) {
    const runStartedAt = Date.now();
    const scheduledEnv = withD1WriteThrottling(env);
    let appError;
    try {
      await runPrimaryScheduled(controller, scheduledEnv, ctx);
    } catch (error) {
      appError = error;
    }

    let leaseError;
    try {
      await expireLeaseWhenPrimaryFailed(env, runStartedAt);
    } catch (error) {
      leaseError = error;
    }

    if (appError) {
      if (leaseError) {
        console.error(JSON.stringify({
          event: 'collector_lease_expiry_failed',
          error: String(leaseError?.message || leaseError),
        }));
      }
      throw appError;
    }
    if (leaseError) throw leaseError;
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const response = await app.fetch(request, env, ctx);
    if (request.method !== 'GET' || (url.pathname !== '/' && url.pathname !== '/health')) {
      return response;
    }

    return rewriteHealthResponse(response);
  },
};
