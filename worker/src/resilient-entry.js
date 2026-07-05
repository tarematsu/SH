import './fetch-guard.js';
import app from './cadenced-entry.js';
import { withDuplicateVelocityReadRemoved } from './d1-read-optimizer.js';
import { withScheduledD1Optimizations } from './d1-scheduled-optimizer.js';
import { createPublicHealthCachedApp } from './public-health-cache.js';
import { createRequestHardenedApp } from './request-hardening.js';

const optimizedApp = {
  scheduled(controller, env, ctx) {
    const optimizedEnv = withScheduledD1Optimizations(
      withDuplicateVelocityReadRemoved(env),
    );
    return app.scheduled(controller, optimizedEnv, ctx);
  },
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
};

export default createPublicHealthCachedApp(createRequestHardenedApp(optimizedApp));
