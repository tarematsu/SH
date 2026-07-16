import minuteWorker, { runMinuteScheduledWithCollectorPriority } from './minute-entry.js';
import { pendingMinuteDeriveTriggers } from './minute-derive-trigger.js';

export const MINUTE_DERIVE_DISPATCH_CRON = '* * * * *';

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

export async function dispatchPendingMinuteFacts(env, dependencies = {}) {
  if (!env?.MINUTE_DERIVE_QUEUE?.send) throw new Error('MINUTE_DERIVE_QUEUE binding is missing');
  const load = dependencies.load || pendingMinuteDeriveTriggers;
  const limit = positiveInteger(env.DERIVE_DISPATCH_LIMIT, 5, 20);
  const triggers = await load(env, { limit });
  if (triggers.length) {
    if (typeof env.MINUTE_DERIVE_QUEUE.sendBatch === 'function') {
      await env.MINUTE_DERIVE_QUEUE.sendBatch(triggers.map((body) => ({ body, contentType: 'json' })));
    } else {
      await Promise.all(triggers.map((body) => env.MINUTE_DERIVE_QUEUE.send(body, { contentType: 'json' })));
    }
  }
  const summary = {
    event: 'minute_derive_dispatch',
    dispatched: triggers.length,
    limit,
  };
  console.log(JSON.stringify(summary));
  return summary;
}

export default {
  fetch: minuteWorker.fetch,
  scheduled(controller, env, ctx) {
    if (String(controller?.cron || '') === MINUTE_DERIVE_DISPATCH_CRON) {
      return dispatchPendingMinuteFacts(env);
    }
    return runMinuteScheduledWithCollectorPriority(controller, env, ctx);
  },
};
