import { withBackfillCursorSeek } from './backfill-cursor-seek.js';
import rebuildWorker from './minute-rebuild-maintenance-entry.js';

export default {
  queue(batch, env, ctx) {
    return rebuildWorker.queue(batch, withBackfillCursorSeek(env), ctx);
  },
};
