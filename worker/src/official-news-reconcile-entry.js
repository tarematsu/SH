import app from './email-recap-index.js';
import { reconcileSupersededAnnouncements } from './official-news-reconcile.js';

function trackingContext(ctx, tasks) {
  if (!ctx?.waitUntil) return ctx;
  return new Proxy(ctx, {
    get(target, property, receiver) {
      if (property === 'waitUntil') {
        return (task) => {
          const pending = Promise.resolve(task);
          tasks.push(pending);
          return target.waitUntil(pending);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export async function runScheduledWithOfficialReconciliation(
  controller,
  env,
  ctx,
  scheduled = app.scheduled.bind(app),
  reconcile = reconcileSupersededAnnouncements,
) {
  const tasks = [];
  const result = await scheduled(controller, env, trackingContext(ctx, tasks));
  const cleanup = Promise.allSettled(tasks)
    .then(() => reconcile(env))
    .catch((error) => {
      console.error(JSON.stringify({
        event: 'official_news_schedule_reconcile_failed',
        error: String(error?.message || error),
      }));
    });
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
