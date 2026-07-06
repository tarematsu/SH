import {
  buddyPlaybackConfig,
  shouldRunBuddyPlayback,
} from './buddy-playback.js';
import { collectBuddyPlaybackGuarded } from './buddy-collection-runner.js';
import { recordBuddyFailure, recordBuddySuccess } from './buddy-health.js';
import coreApp from './scheduled-main.js';
import diagnosticApp from './health-alert-index.js';

const DEFAULT_DIAGNOSTIC_INTERVAL_MINUTES = 10;
const FAILURE_DIAGNOSTIC_WINDOW_MS = 10 * 60_000;
let forceDiagnosticsUntil = 0;
let buddyPlaybackFlight = null;

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

export function resetBuddyPlaybackFlightForTests() {
  buddyPlaybackFlight = null;
}

export function scheduledTimestamp(controller, fallback = Date.now()) {
  const value = Number(controller?.scheduledTime);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function safeNow(now) {
  const value = Number(now());
  return Number.isFinite(value) ? value : Date.now();
}

function healthWriteError(event, error) {
  console.error(JSON.stringify({
    event,
    error: String(error?.message || error),
  }));
}

export function scheduleBuddyPlayback(
  env,
  ctx,
  scheduledAt = Date.now(),
  runner = collectBuddyPlaybackGuarded,
  now = Date.now,
) {
  const config = buddyPlaybackConfig(env);
  if (!config.enabled) return Promise.resolve({ skipped: true, reason: 'disabled' });
  if (!shouldRunBuddyPlayback(scheduledAt, config.intervalMs)) {
    return Promise.resolve({ skipped: true, reason: 'not-due' });
  }
  if (buddyPlaybackFlight) {
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(buddyPlaybackFlight);
    return buddyPlaybackFlight;
  }

  const observedAt = safeNow(now);
  const task = Promise.resolve().then(async () => {
    try {
      const result = await runner(env, observedAt);
      await recordBuddySuccess(env, config.alias, result, safeNow(now))
        .catch((error) => healthWriteError('buddy_playback_health_success_write_failed', error));
      return result;
    } catch (error) {
      await recordBuddyFailure(env, config.alias, error, safeNow(now))
        .catch((healthError) => healthWriteError('buddy_playback_health_failure_write_failed', healthError));
      console.error(JSON.stringify({
        event: 'buddy_playback_collection_failed',
        error: String(error?.message || error),
      }));
      return { skipped: true, reason: 'collection-failed' };
    }
  });
  buddyPlaybackFlight = task.finally(() => {
    if (buddyPlaybackFlight === task || buddyPlaybackFlight === wrappedTask) {
      buddyPlaybackFlight = null;
    }
  });
  const wrappedTask = buddyPlaybackFlight;
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(wrappedTask);
  return wrappedTask;
}

export default {
  async scheduled(controller, env, ctx) {
    const scheduledAt = scheduledTimestamp(controller);
    scheduleBuddyPlayback(env, ctx, scheduledAt);
    if (shouldRunFullDiagnostics(scheduledAt, env)) {
      try {
        return await diagnosticApp.scheduled(controller, env, ctx);
      } catch (error) {
        markDiagnosticFailure(scheduledAt);
        throw error;
      }
    }
    try {
      return await coreApp.scheduled(controller, env, ctx);
    } catch (error) {
      markDiagnosticFailure(scheduledAt);
      throw error;
    }
  },

  async fetch(request, env, ctx) {
    return diagnosticApp.fetch(request, env, ctx);
  },
};
