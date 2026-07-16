import './fetch-guard.js';
import { refreshFastPagesReadModels, refreshPagesReadModels } from './pages-read-model-refresh.js';

export const PAGES_READ_MODEL_CRON = '*/15 * * * *';

export async function runPagesReadModelCron(controller, env) {
  if (String(controller?.cron || '') !== PAGES_READ_MODEL_CRON) {
    return { skipped: true, reason: 'unsupported-pages-read-model-cron' };
  }
  const now = Number(controller?.scheduledTime) || Date.now();
  const minute = new Date(now).getUTCMinutes();
  if (minute === 30) return refreshPagesReadModels(env, now);
  return refreshFastPagesReadModels(env, now);
}

export default {
  scheduled: runPagesReadModelCron,
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
