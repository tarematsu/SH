import app from './email-recap-index.js';
import { reconcileSupersededAnnouncements } from './official-news-reconcile.js';

function trackingOfficialTaskContext(ctx, state) {
  if (!ctx?.waitUntil) return ctx;
  return new Proxy(ctx, {
    get(target, property, receiver) {
      if (property === 'waitUntil') {
        return (task) => {
          const pending = Promise.resolve(task);
          // email-recap-index delegates to official-news-index first. Its monitor
          // registers the first waitUntil task; later tasks belong to host/profile
          // monitoring and must not delay schedule reconciliation.
          if (!state.officialTask) state.officialTask = pending;
          return target.waitUntil(pending);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function logReconcileFailure(error) {
  console.error(JSON.stringify({
    event: 'official_news_schedule_reconcile_failed',
    error: String(error?.message || error),
  }));
}

export async function runScheduledWithOfficialReconciliation(
  controller,
  env,
  ctx,
  scheduled = app.scheduled.bind(app),
  reconcile = reconcileSupersededAnnouncements,
) {
  const runStartedAt = Date.now();
  const state = { officialTask: null };
  const result = await scheduled(controller, env, trackingOfficialTaskContext(ctx, state));
  if (!state.officialTask) return result;

  const cleanup = state.officialTask
    .then(() => reconcile(env, runStartedAt))
    .catch(logReconcileFailure);
  if (ctx?.waitUntil) ctx.waitUntil(cleanup);
  else await cleanup;
  return result;
}

export default {
  scheduled(controller, env, ctx) {
    return runScheduledWithOfficialReconciliation(controller, env, ctx);
  },

  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
};
