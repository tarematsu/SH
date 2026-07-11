import { runMinuteFactsBackfill } from './minute-facts-backfill.js';
import { runMinuteFactDeriveCron } from './minute-facts-derive.js';
import { runMinuteFactsLegacyBackfill } from './minute-facts-legacy-backfill.js';

export const MINUTE_FACT_DERIVE_CRON = '*/2 * * * *';
export const MINUTE_FACT_REBUILD_CRON = '7,17,27,37,47,57 * * * *';
export const MINUTE_FACT_LEGACY_CRON = '9,19,29,39,49,59 * * * *';

export async function runMinuteScheduled(controller = {}, env, dependencies = {}) {
  const cron = String(controller.cron || '');
  if (cron === MINUTE_FACT_DERIVE_CRON) return (dependencies.runDerive || runMinuteFactDeriveCron)(env, dependencies.derive || {});
  if (cron === MINUTE_FACT_REBUILD_CRON) return (dependencies.runRebuild || runMinuteFactsBackfill)(env, dependencies.rebuild || {});
  if (cron === MINUTE_FACT_LEGACY_CRON) return (dependencies.runLegacy || runMinuteFactsLegacyBackfill)(env, dependencies.legacy || {});
  return { skipped: true, reason: 'unsupported-minute-facts-cron', cron };
}

export default {
  scheduled(controller, env, ctx) { return runMinuteScheduled(controller, env, { ctx }); },
  fetch() { return new Response('Not found', { status: 404 }); },
};
