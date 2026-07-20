import {
  assertConsolidatedConsumers,
  COLLECTOR_SCRIPT,
  CONSOLIDATED_SCRIPT,
  hasConsumer,
  MIGRATIONS,
  pauseQueue,
  removeConsumer,
  restoreConsumer,
  resumeQueue,
} from './monitor-cutover-queues.mjs';
import {
  deleteWorker,
  deployConsolidatedWorker,
  rollbackConsolidatedWorker,
} from './monitor-cutover-cloudflare.mjs';

const retiredFirst = [
  ...MIGRATIONS.map(({ oldScript }) => oldScript),
  'sh-buddies-read-model',
  'sh-monitor-maintenance',
];
const existed = new Map(
  MIGRATIONS.map((item) => [item.queue, hasConsumer(item.queue, CONSOLIDATED_SCRIPT)]),
);
const active = MIGRATIONS.filter((item) => hasConsumer(item.queue, item.oldScript));
const paused = [];
const removed = [];
let deployed = false;
let collectorRetired = false;

try {
  for (const item of active) {
    pauseQueue(item.queue);
    paused.push(item);
    removeConsumer(item.queue, item.oldScript);
    removed.push(item);
  }
  deployConsolidatedWorker();
  deployed = true;
  assertConsolidatedConsumers();
  for (const script of retiredFirst) await deleteWorker(script);
  assertConsolidatedConsumers();
  for (const item of paused) resumeQueue(item.queue);
  paused.length = 0;
  await deleteWorker(COLLECTOR_SCRIPT);
  collectorRetired = true;
} catch (error) {
  const failures = [];
  if (deployed && !collectorRetired) {
    try { rollbackConsolidatedWorker(); }
    catch (cause) { failures.push(`Worker rollback failed: ${cause.message}`); }
  }
  for (const item of MIGRATIONS.toReversed()) {
    try {
      if (!existed.get(item.queue) && hasConsumer(item.queue, CONSOLIDATED_SCRIPT)) {
        removeConsumer(item.queue, CONSOLIDATED_SCRIPT, { allowFailure: true });
      }
    } catch (cause) { failures.push(`Consumer rollback failed: ${cause.message}`); }
  }
  for (const item of removed.toReversed()) {
    try { if (!hasConsumer(item.queue, item.oldScript)) restoreConsumer(item); }
    catch (cause) { failures.push(`Consumer restore failed: ${cause.message}`); }
  }
  for (const item of paused.toReversed()) {
    try { resumeQueue(item.queue); }
    catch (cause) { failures.push(`Queue resume failed: ${cause.message}`); }
  }
  if (failures.length) {
    throw new AggregateError(
      [error, ...failures.map((message) => new Error(message))],
      'monitor consolidation failed and rollback was incomplete',
    );
  }
  throw error;
}

console.log(JSON.stringify({
  event: 'monitor_worker_consolidation_completed',
  script: CONSOLIDATED_SCRIPT,
  queues: MIGRATIONS.map((item) => item.queue),
  retired_scripts: [...retiredFirst, COLLECTOR_SCRIPT],
}));
