import { runBuddyPlayback } from './buddy-playback.js';
import coreApp from './scheduled-main.js';
import diagnosticApp from './health-alert-index.js';

const DEFAULT_DIAGNOSTIC_INTERVAL_MINUTES = 10;
const FAILURE_DIAGNOSTIC_WINDOW_MS = 10 * 60_000;
let forceDiagnosticsUntil = 0;

export function diagnosticIntervalMinutes(env = {}) {
  const configured = Number(env.DIAGNOSTIC_INTERVAL_MINUTES ?? DEFAULT_DIAGNOSTIC_INTERVAL_MINUTES);
  if (!Number.isFinite(configured)) return DEFAULT_DIAGNOSTIC_INTERVAL_MINUTES;
  return Math.max(1, Math.min(60, Math.trunc(configured)));
}

export function shouldRunFullDiagnostics(now = Date.now(), env = {}) {
  return now < forceDiagnosticsUntil
    || Math.floor(now / 60_000) % diagnosticIntervalMinutes(env) === 0;
}

export function markDiagnosticFailure(now = Date.now()) {
  forceDiagnosticsUntil = Math.max(forceDiagnosticsUntil, now + FAILURE_DIAGNOSTIC_WINDOW_MS);
}

export function resetDiagnosticFailureWindow() {
  forceDiagnosticsUntil = 0;
}

function scheduleBuddyPlayback(env, ctx) {
  const task = runBuddyPlayback(env).catch((error) => {
    console.error(JSON.stringify({
      event: 'buddy_playback_collection_failed',
      error: String(error?.message || error),
    }));
  });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
}

export default {
  async scheduled(controller, env, ctx) {
    scheduleBuddyPlayback(env, ctx);
    if (shouldRunFullDiagnostics(Date.now(), env)) {
      try {
        return await diagnosticApp.scheduled(controller, env, ctx);
      } catch (error) {
        markDiagnosticFailure();
        throw error;
      }
    }
    try {
      return await coreApp.scheduled(controller, env, ctx);
    } catch (error) {
      markDiagnosticFailure();
      throw error;
    }
  },

  async fetch(request, env, ctx) {
    return diagnosticApp.fetch(request, env, ctx);
  },
};
