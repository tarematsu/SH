import {
  assertConsolidatedConsumers,
  assertConsolidatedConsumersPresent,
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

const retiredQueueWorkers = [
  ...MIGRATIONS.map(({ oldScript }) => oldScript),
  'sh-buddies-read-model',
  'sh-monitor-maintenance',
];
const retiredScheduledWorkers = [
  COLLECTOR_SCRIPT,
  'sh-minute-maintenance',
];
const existed = new Map(
  MIGRATIONS.map((item) => [item.queue, hasConsumer(item.queue, CONSOLIDATED_SCRIPT)]),
);
const active = MIGRATIONS.filter((item) => hasConsumer(item.queue, item.oldScript));
const paused = [];
const removed = [];
let deployed = false;
let cutoverCommitted = false;

try {
  for (const item of active) {
    pauseQueue(item.queue);
    paused.push(item);
  }

  // Deploy first while the old consumers remain attached. This makes the
  // cutover reversible without creating a window in which collection or
  // maintenance has no consumer.
  deployConsolidatedWorker();
  deployed = true;
  assertConsolidatedConsumersPresent();
  for (const item of active) {
    removeConsumer(item.queue, item.oldScript);
    removed.push(item);
  }
  assertConsolidatedConsumers();
  for (const script of retiredQueueWorkers) await deleteWorker(script);
  assertConsolidatedConsumers();
  for (const item of paused) resumeQueue(item.queue);
  paused.length = 0;
  cutoverCommitted = true;

  // Scheduled Worker retirement is intentionally after the reversible cutover.
  // A deletion failure leaves the consolidated Worker active and is safe to retry.
  for (const script of retiredScheduledWorkers) await deleteWorker(script);
} catch (error) {
  if (cutoverCommitted) throw error;
  const failures = [];
  if (deployed) {
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
  retired_scripts: [...retiredQueueWorkers, ...retiredScheduledWorkers],
}));
