import { runOtherMonitorScheduled } from './other-monitor-entry.js';

const EMPTY_OPTIONS = Object.freeze({});
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
export const OTHER_MONITOR_SUCCESS_MESSAGE = 'other-monitor-success';

export async function dispatchOtherMonitorStage(controller, env, ctx, options = EMPTY_OPTIONS) {
  const result = options.dependencies
    ? await runOtherMonitorScheduled(controller, env, ctx, options.dependencies)
    : await runOtherMonitorScheduled(controller, env, ctx);
  if (!env?.HOST_MONITOR_QUEUE?.send) {
    throw new Error('HOST_MONITOR_QUEUE binding is missing for monitor success dispatch');
  }
  const scheduledAt = Number(controller?.scheduledTime) || Date.now();
  await env.HOST_MONITOR_QUEUE.send({
    message_type: OTHER_MONITOR_SUCCESS_MESSAGE,
    message_version: 1,
    at: scheduledAt,
  }, JSON_QUEUE_SEND_OPTIONS);
  options.healthApp?.invalidateHealthCache?.();
  return result;
}
