import app from './browser-index-v2.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeoutMessage(value) {
  return /timeout|timed out|operation was aborted/i.test(String(value || ''));
}

async function readCollectorState(env) {
  if (!env.DB) return null;
  return env.DB.prepare(`
    SELECT last_run_at, last_success_at, last_error
    FROM sh_worker_collector_state
    WHERE id = 'stationhead'
  `).first();
}

export default {
  async scheduled(controller, env, ctx) {
    const startedAt = Date.now();
    await app.scheduled(controller, env, ctx);

    const state = await readCollectorState(env).catch(() => null);
    const succeeded = Number(state?.last_success_at || 0) >= startedAt;
    if (succeeded || !isTimeoutMessage(state?.last_error)) return;

    console.warn(JSON.stringify({
      event: 'stationhead_collection_retry',
      reason: state?.last_error || 'timeout',
    }));

    await sleep(1_500);
    await app.scheduled(controller, env, ctx);
  },

  async fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
};
