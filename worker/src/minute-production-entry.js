import minuteWorker from './minute-entry.js';

const EVERY_MINUTE_CRON = '* * * * *';
const LEGACY_DERIVE_CRON = '*/2 * * * *';

export default {
  ...minuteWorker,
  scheduled(controller, env, ctx) {
    const activeController = String(controller?.cron || '') === EVERY_MINUTE_CRON
      ? { ...controller, cron: LEGACY_DERIVE_CRON }
      : controller;
    return minuteWorker.scheduled(activeController, env, ctx);
  },
};
