import worker, { runOtherCron, scheduledTimestamp } from './other-entry.js';

const PAGES_REFRESH_INTERVAL_MINUTES = 10;

export function pagesRefreshDue(controller, intervalMinutes = PAGES_REFRESH_INTERVAL_MINUTES) {
  const interval = Math.max(5, Math.trunc(Number(intervalMinutes) || PAGES_REFRESH_INTERVAL_MINUTES));
  const absoluteMinute = Math.floor(scheduledTimestamp(controller) / 60_000);
  return absoluteMinute % interval === 0;
}

export async function runOtherProductionCron(controller, env, ctx) {
  if (pagesRefreshDue(controller)) return runOtherCron(controller, env, ctx);
  return runOtherCron(controller, env, ctx, {
    dependencies: {
      pages: async () => ({ skipped: true, reason: 'pages-refresh-not-due' }),
    },
  });
}

export default {
  ...worker,
  scheduled: runOtherProductionCron,
};
