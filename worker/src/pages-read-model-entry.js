import './fetch-guard.js';
import { refreshFastPagesReadModels, refreshPagesReadModels } from './pages-read-model-refresh.js';

export const PAGES_FAST_READ_MODEL_CRON = '*/15 * * * *';
export const PAGES_FULL_READ_MODEL_CRON = '31 * * * *';

export async function runPagesReadModelCron(controller, env, dependencies = {}) {
  const cron = String(controller?.cron || '');
  const now = Number(controller?.scheduledTime) || Date.now();
  if (cron === PAGES_FAST_READ_MODEL_CRON) {
    const refresh = dependencies.refreshFast || refreshFastPagesReadModels;
    return refresh(env, now);
  }
  if (cron === PAGES_FULL_READ_MODEL_CRON) {
    const refresh = dependencies.refreshFull || refreshPagesReadModels;
    return refresh(env, now);
  }
  return { skipped: true, reason: 'unsupported-pages-read-model-cron', cron };
}

export default {
  scheduled: runPagesReadModelCron,
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
