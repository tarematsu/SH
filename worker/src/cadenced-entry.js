import coreApp from './main.js';
import diagnosticApp from './health-alert-index.js';

const DEFAULT_DIAGNOSTIC_INTERVAL_MINUTES = 5;

export function diagnosticIntervalMinutes(env = {}) {
  const configured = Number(env.DIAGNOSTIC_INTERVAL_MINUTES ?? DEFAULT_DIAGNOSTIC_INTERVAL_MINUTES);
  if (!Number.isFinite(configured)) return DEFAULT_DIAGNOSTIC_INTERVAL_MINUTES;
  return Math.max(1, Math.min(60, Math.trunc(configured)));
}

export function shouldRunFullDiagnostics(now = Date.now(), env = {}) {
  return Math.floor(now / 60_000) % diagnosticIntervalMinutes(env) === 0;
}

export default {
  async scheduled(controller, env, ctx) {
    if (shouldRunFullDiagnostics(Date.now(), env)) {
      return diagnosticApp.scheduled(controller, env, ctx);
    }
    return coreApp.scheduled(controller, env, ctx);
  },

  async fetch(request, env, ctx) {
    return diagnosticApp.fetch(request, env, ctx);
  },
};
