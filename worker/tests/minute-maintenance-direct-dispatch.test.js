import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchMinuteMaintenanceGate } from '../src/minute-maintenance-optimized-entry.js';

const SCHEDULED_AT = Date.UTC(2026, 0, 1, 0, 7, 0);
const CRON = '5,7,9,15,17,19,25,27,29,35,37,39,45,47,49,55,57,59 * * * *';

function collectorDb(row) {
  return {
    prepare(sql) {
      assert.match(sql, /sh_worker_collector_state/);
      return { async first() { return row; } };
    },
  };
}

function queueCapture() {
  const sends = [];
  return {
    sends,
    queue: {
      async send(body, options) { sends.push({ body, options }); },
    },
  };
}

test('ready rebuild maintenance skips the gate message and dispatches gap-scan directly', async () => {
  const capture = queueCapture();
  const env = {
    HISTORICAL_REBUILD_ENABLED: true,
    REBUILD_HISTORICAL_BACKFILL_ENABLED: false,
    BUDDIES_DB: collectorDb({
      last_run_at: SCHEDULED_AT,
      last_success_at: SCHEDULED_AT,
      last_error: null,
    }),
    MINUTE_REBUILD_QUEUE: capture.queue,
  };

  const result = await dispatchMinuteMaintenanceGate(
    { cron: CRON, scheduledTime: SCHEDULED_AT },
    env,
    'rebuild',
  );

  assert.equal(result.dispatched_stage, 'gap-scan');
  assert.equal(result.historical_backfill_due, false);
  assert.equal(capture.sends.length, 1);
  assert.equal(capture.sends[0].body.stage, 'gap-scan');
  assert.equal(capture.sends[0].body.allow_backfill, false);
  assert.deepEqual(capture.sends[0].options, { contentType: 'json' });
});

test('ready sync maintenance dispatches the final run stage directly', async () => {
  const capture = queueCapture();
  const env = {
    BUDDIES_DB: collectorDb({
      last_run_at: SCHEDULED_AT,
      last_success_at: SCHEDULED_AT,
      last_error: null,
    }),
    MINUTE_REBUILD_QUEUE: capture.queue,
  };

  const result = await dispatchMinuteMaintenanceGate(
    { cron: CRON, scheduledTime: SCHEDULED_AT },
    env,
    'sync',
  );

  assert.equal(result.dispatched_stage, 'maintenance-run');
  assert.equal(capture.sends.length, 1);
  assert.equal(capture.sends[0].body.stage, 'maintenance-run');
  assert.equal(capture.sends[0].body.maintenance_task, 'sync');
});

test('collector-not-ready maintenance retains one bounded gate retry', async () => {
  const capture = queueCapture();
  const env = {
    BUDDIES_DB: collectorDb({
      last_run_at: SCHEDULED_AT - 60_000,
      last_success_at: SCHEDULED_AT - 60_000,
      last_error: null,
    }),
    MINUTE_REBUILD_QUEUE: capture.queue,
  };

  const result = await dispatchMinuteMaintenanceGate(
    { cron: CRON, scheduledTime: SCHEDULED_AT },
    env,
    'sync',
  );

  assert.equal(result.requeued, true);
  assert.equal(result.attempt, 1);
  assert.equal(capture.sends.length, 1);
  assert.equal(capture.sends[0].body.stage, 'maintenance-gate');
  assert.equal(capture.sends[0].body.attempt, 1);
  assert.deepEqual(capture.sends[0].options, { contentType: 'json', delaySeconds: 4 });
});

test('disabled historical rebuild does not enqueue gap work', async () => {
  const capture = queueCapture();
  const result = await dispatchMinuteMaintenanceGate(
    { cron: CRON, scheduledTime: SCHEDULED_AT },
    {
      HISTORICAL_REBUILD_ENABLED: false,
      BUDDIES_DB: collectorDb({
        last_run_at: SCHEDULED_AT,
        last_success_at: SCHEDULED_AT,
        last_error: null,
      }),
      MINUTE_REBUILD_QUEUE: capture.queue,
    },
    'rebuild',
  );

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'historical-rebuild-disabled-for-d1-budget');
  assert.deepEqual(capture.sends, []);
});
