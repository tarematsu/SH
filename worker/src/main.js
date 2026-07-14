import { withD1WriteThrottling } from './main-d1-throttle.js';
import { runPrimaryScheduled } from './main-scheduler.js';
import { runOptimizedScheduled } from './optimized-index.js';

export { rewriteThrottledSql, withD1WriteThrottling } from './main-d1-throttle.js';
export { normalizeHealthPayload, rewriteHealthResponse } from './main-health.js';
export {
  PrimaryCollectionTimeoutError,
  resetPrimaryScheduledFlightForTests,
  runPrimaryScheduled,
} from './main-scheduler.js';

export default {
  async scheduled(controller, env, ctx) {
    const scheduledEnv = withD1WriteThrottling(env);
    return runPrimaryScheduled(controller, scheduledEnv, ctx, runOptimizedScheduled);
  },

  async fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
