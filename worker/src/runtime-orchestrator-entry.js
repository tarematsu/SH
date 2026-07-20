import './fetch-guard.js';

import { runRuntimeQueue } from './runtime-queue.js';
import { runRuntimeScheduled } from './runtime-scheduled.js';

export * from './runtime-env.js';
export * from './runtime-queue.js';
export * from './runtime-scheduled.js';

export default {
  scheduled: runRuntimeScheduled,
  queue: runRuntimeQueue,
  async fetch(request, env, ctx) {
    return (await import('./other-monitor-entry.js')).default.fetch(request, env, ctx);
  },
};
