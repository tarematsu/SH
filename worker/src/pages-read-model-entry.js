import './fetch-guard.js';
import { runDispatchedPagesReadModelTask } from './pages-read-model-dispatch.js';

export const PAGES_READ_MODEL_CRON = '* * * * *';

function scheduledTimestamp(controller, fallback = Date.now()) {
  const value = Number(controller?.scheduledTime);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function assertRefreshSucceeded(result) {
  if (!result || typeof result !== 'object') return result;
  const failures = Array.isArray(result.responses)
    ? result.responses.filter((item) => item?.ok === false)
    : [];
  if (Number(result.failed || failures.length) > 0) {
    const task = result.task?.key || result.task?.kind || 'unknown';
    throw new AggregateError(
      failures.map((item) => new Error(`${item.key || task}: ${item.error || 'materialization failed'}`)),
      `Pages read-model task ${task} failed for ${failures.length || result.failed} response(s)`,
    );
  }
  return result;
}

export async function runPagesReadModelCron(controller, env, dependencies = {}) {
  const cron = String(controller?.cron || '');
  if (cron !== PAGES_READ_MODEL_CRON) {
    return { skipped: true, reason: 'unsupported-pages-read-model-cron', cron };
  }
  const now = scheduledTimestamp(controller);
  const runTask = dependencies.runTask || runDispatchedPagesReadModelTask;
  return assertRefreshSucceeded(await runTask(env, now, dependencies));
}

export default {
  scheduled: runPagesReadModelCron,
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
