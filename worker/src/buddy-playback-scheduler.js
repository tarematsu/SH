import {
  buddyPlaybackConfig,
  shouldRunBuddyPlayback,
} from './buddy-playback.js';
import { collectBuddyPlaybackGuarded } from './buddy-collection-runner.js';
import { recordBuddyFailure, recordBuddySuccess } from './buddy-health.js';
import { sanitizeFailureDetail } from './collector-failure.js';

let buddyPlaybackFlightsByContext = new WeakMap();

export function resetBuddyPlaybackFlightForTests() {
  buddyPlaybackFlightsByContext = new WeakMap();
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
    error: sanitizeFailureDetail(error?.message || error),
  }));
}

function requestContextKey(ctx) {
  return ctx && (typeof ctx === 'object' || typeof ctx === 'function') ? ctx : null;
}

function releaseBuddyFlight(ctx, flight) {
  const key = requestContextKey(ctx);
  if (key && buddyPlaybackFlightsByContext.get(key) === flight) {
    buddyPlaybackFlightsByContext.delete(key);
  }
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

  const key = requestContextKey(ctx);
  const existing = key ? buddyPlaybackFlightsByContext.get(key) : null;
  if (existing) {
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(existing);
    return existing;
  }

  const observedAt = safeNow(now);
  const task = Promise.resolve().then(async () => {
    try {
      const result = await runner(env, observedAt);
      if (result?.skipped) {
        const reason = String(result.reason || 'unknown');
        await recordBuddyFailure(env, config.alias, new Error(`Buddy playback skipped: ${reason}`), safeNow(now))
          .catch((healthError) => healthWriteError('buddy_playback_health_skip_write_failed', healthError));
        return result;
      }
      await recordBuddySuccess(env, config.alias, result, safeNow(now))
        .catch((error) => healthWriteError('buddy_playback_health_success_write_failed', error));
      return result;
    } catch (error) {
      await recordBuddyFailure(env, config.alias, error, safeNow(now))
        .catch((healthError) => healthWriteError('buddy_playback_health_failure_write_failed', healthError));
      console.error(JSON.stringify({
        event: 'buddy_playback_collection_failed',
        error: sanitizeFailureDetail(error?.message || error),
      }));
      return { skipped: true, reason: 'collection-failed' };
    }
  });
  const wrappedTask = task.finally(() => releaseBuddyFlight(ctx, wrappedTask));
  if (key) buddyPlaybackFlightsByContext.set(key, wrappedTask);
  if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(wrappedTask);
  return wrappedTask;
}
