const EMPTY_DEPENDENCIES = Object.freeze({});
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });

export const PAGES_READ_MODEL_CRON = '* * * * *';
export const PAGES_READ_MODEL_DISPATCH_MESSAGE = 'stationhead-pages-read-model-dispatch';

function scheduledTimestamp(controller) {
  const value = controller?.scheduledTime;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : Date.now();
  }
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now();
}

export async function dispatchPagesReadModelScheduled(
  controller,
  env,
  dependencies = EMPTY_DEPENDENCIES,
) {
  const cron = String(controller?.cron || '');
  if (cron !== PAGES_READ_MODEL_CRON) {
    return { skipped: true, reason: 'unsupported-pages-read-model-cron', cron };
  }
  const scheduledAt = scheduledTimestamp(controller);
  const send = dependencies.sendScheduledTask
    || ((body) => env?.PAGES_READ_MODEL_QUEUE?.send(body, JSON_QUEUE_SEND_OPTIONS));
  if (!dependencies.sendScheduledTask && !env?.PAGES_READ_MODEL_QUEUE?.send) {
    throw new Error('PAGES_READ_MODEL_QUEUE binding is missing');
  }
  await send({
    message_type: PAGES_READ_MODEL_DISPATCH_MESSAGE,
    message_version: 1,
    scheduled_at: scheduledAt,
  });
  return {
    dispatched: true,
    task: 'pages-read-model-scheduled',
    scheduled_at: scheduledAt,
  };
}
