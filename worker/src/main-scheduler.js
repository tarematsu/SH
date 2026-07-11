import app from './email-recap-index.js';
import { runCloudHostMonitor } from './cloud-host-monitor.js';
import { runCloudWeeklyLeaderboard } from './cloud-weekly-leaderboard.js';
import { runScheduledMaintenance } from './scheduled-maintenance.js';

const DEFAULT_PRIMARY_WATCHDOG_MS = 55_000;
const MIN_PRIMARY_WATCHDOG_MS = 10_000;
const MAX_PRIMARY_WATCHDOG_MS = 55_000;

const DEFAULT_AUXILIARY_RUNNERS = Object.freeze({
  weekly: { failureEvent: 'cloud_weekly_leaderboard_failed', run: runCloudWeeklyLeaderboard },
  maintenance: { failureEvent: 'data_maintenance_failed', run: runScheduledMaintenance },
  host: { failureEvent: 'cloud_host_monitor_failed', run: runCloudHostMonitor, onFailureOnly: true },
});

export function resetPrimaryScheduledFlightForTests() {
  // Compatibility no-op. Scheduled promises are request-scoped.
}

export async function runPrimaryScheduled(
  controller,
  env,
  ctx,
  scheduled = app.scheduled.bind(app),
  timeoutOverride = null,
  options = {},
) {
  const timeoutMs = timeoutOverride ?? primaryWatchdogMs(env);
  const flight = {
    primary: Promise.resolve().then(() => scheduled(controller, env, ctx)),
  };
  let timeoutId = null;

  try {
    const result = await Promise.race([
      flight.primary,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          options.resetCollectionFlight?.();
          reject(new PrimaryCollectionTimeoutError(timeoutMs, controller?.cron));
        }, timeoutMs);
      }),
    ]);
    const auxiliary = startAuxiliaryOnce(
      flight, env, false, options.auxiliaryRunners || DEFAULT_AUXILIARY_RUNNERS,
    );
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(auxiliary);
    else await auxiliary;
    return result;
  } catch (error) {
    const auxiliary = startAuxiliaryOnce(
      flight, env, true, options.auxiliaryRunners || DEFAULT_AUXILIARY_RUNNERS,
    );
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(auxiliary);
    else await auxiliary;
    throw error;
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
}
