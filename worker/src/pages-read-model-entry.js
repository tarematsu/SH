import './fetch-guard.js';
import {
  refreshFastPagesReadModels,
  refreshTrackHistoryPagesReadModel,
} from './pages-read-model-refresh.js';

export const PAGES_FAST_READ_MODEL_CRON = '*/5 * * * *';
export const PAGES_FULL_READ_MODEL_CRON = '31 * * * *';

function scheduledTimestamp(controller, fallback = Date.now()) {
  const value = Number(controller?.scheduledTime);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function assertRefreshSucceeded(kind, result) {
  if (!result || typeof result !== 'object') return result;
  if (result.skipped && result.reason === 'db-binding-missing') {
    throw new Error(`${kind} Pages read-model refresh is missing a required D1 binding`);
  }
  const failures = Array.isArray(result.responses)
    ? result.responses.filter((item) => item?.ok === false)
    : [];
  if (Number(result.failed || failures.length) > 0) {
    throw new AggregateError(
      failures.map((item) => new Error(`${item.key || 'unknown'}: ${item.error || 'materialization failed'}`)),
      `${kind} Pages read-model refresh failed for ${failures.length || result.failed} response(s)`,
    );
  }
  return result;
}

export async function runPagesReadModelCron(controller, env, dependencies = {}) {
  const cron = String(controller?.cron || '');
  const now = scheduledTimestamp(controller);
  if (cron === PAGES_FAST_READ_MODEL_CRON) {
    const refresh = dependencies.refreshFast || refreshFastPagesReadModels;
    return assertRefreshSucceeded('fast', await refresh(env, now));
  }
  if (cron === PAGES_FULL_READ_MODEL_CRON) {
    const refresh = dependencies.refreshFull || refreshTrackHistoryPagesReadModel;
    return assertRefreshSucceeded('full', await refresh(env, now));
  }
  return { skipped: true, reason: 'unsupported-pages-read-model-cron', cron };
}

export default {
  scheduled: runPagesReadModelCron,
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
