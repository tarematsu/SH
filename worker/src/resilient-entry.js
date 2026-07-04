import './fetch-guard.js';
import app from './cadenced-entry.js';
import { withDuplicateVelocityReadRemoved } from './d1-read-optimizer.js';
import { createPublicHealthCachedApp } from './public-health-cache.js';

const optimizedApp = {
  scheduled(controller, env, ctx) {
    return app.scheduled(controller, withDuplicateVelocityReadRemoved(env), ctx);
  },
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
};

export default createPublicHealthCachedApp(optimizedApp);
