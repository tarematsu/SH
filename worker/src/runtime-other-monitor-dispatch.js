import { runOtherMonitorScheduled } from './other-monitor-entry.js';

const EMPTY_OPTIONS = Object.freeze({});

export async function dispatchOtherMonitorStage(controller, env, ctx, options = EMPTY_OPTIONS) {
  const result = options.dependencies
    ? await runOtherMonitorScheduled(controller, env, ctx, options.dependencies)
    : await runOtherMonitorScheduled(controller, env, ctx);
  options.healthApp?.invalidateHealthCache?.();
  return result;
}
