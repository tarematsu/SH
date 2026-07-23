import './fetch-guard.js';

import { sanitizeFailureDetail } from './collector-failure.js';
import ingestWorker from './ingest-channel-optimized-entry.js';
import { collectRawChannel } from './raw-collector-entry.js';
import { rawCollectorEnv } from './runtime-env.js';

const EMPTY_DEPENDENCIES = Object.freeze({});

export const BUDDIES_COLLECTOR_CRON = '* * * * *';
export const BUDDIES_COLLECTOR_QUEUE_NAMES = Object.freeze([
  'stationhead-raw-collection',
  'stationhead-ingest-finalize',
  'stationhead-comments',
  'stationhead-buddies-persist',
]);

const BUDDIES_COLLECTOR_QUEUE_SET = new Set(BUDDIES_COLLECTOR_QUEUE_NAMES);

export async function runBuddiesCollectorScheduled(
  controller,
  env,
  _ctx,
  dependencies = EMPTY_DEPENDENCIES,
) {
  const cron = String(controller?.cron || '');
  if (cron !== BUDDIES_COLLECTOR_CRON) {
    return { skipped: true, reason: 'unsupported-buddies-collector-cron', cron };
  }

  const scheduledAt = Number(controller?.scheduledTime) || Date.now();
  const collect = dependencies.collectRawChannel || collectRawChannel;
  try {
    await collect(
      rawCollectorEnv(env),
      dependencies.collection || EMPTY_DEPENDENCIES,
    );
    return { collected: true, scheduled_at: scheduledAt };
  } catch (error) {
    console.error(JSON.stringify({
      event: 'buddies_collection_failed',
      scheduled_at: scheduledAt,
      error: sanitizeFailureDetail(error?.message || error),
    }));
    throw error;
  }
}

export async function runBuddiesCollectorQueue(
  batch,
  env,
  ctx,
  dependencies = EMPTY_DEPENDENCIES,
) {
  const queueName = String(batch?.queue || '');
  if (!BUDDIES_COLLECTOR_QUEUE_SET.has(queueName)) {
    throw new Error(`unsupported buddies collector queue: ${queueName || 'unknown'}`);
  }
  const run = dependencies.runIngestQueue || ingestWorker.queue;
  return run(
    batch,
    rawCollectorEnv(env),
    ctx,
    dependencies.ingest || EMPTY_DEPENDENCIES,
  );
}

export default {
  scheduled: runBuddiesCollectorScheduled,
  queue: runBuddiesCollectorQueue,
};
