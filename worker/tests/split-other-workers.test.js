import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  PAGES_READ_MODEL_CRON,
  runPagesReadModelCron,
} from '../src/pages-read-model-entry.js';
import {
  ROLLUP_MAINTENANCE_CRON,
  SNAPSHOT_RETENTION_CRON,
  runMonitorMaintenanceCron,
} from '../src/monitor-maintenance-entry.js';
import {
  OTHER_MONITOR_CRON,
  otherMonitorTask,
  runOtherMonitorCron,
  runOtherMonitorScheduled,
} from '../src/other-monitor-entry.js';
import {
  MONITOR_MAINTENANCE_MESSAGE,
  runConsolidatedMonitorQueue,
  runConsolidatedMonitorScheduled,
} from '../src/consolidated-monitor-entry.js';

function config(name) {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

test('Pages read-model Worker runs one six-hour task slot from a one-minute Cron', async () => {
  const calls = [];
  const dependencies = {
    runTask: async (_env, now) => {
      calls.push(now);
      return { skipped: false, task: { key: 'dashboard-history' }, responses: [], failed: 0 };
    },
  };

  assert.equal(PAGES_READ_MODEL_CRON, '* * * * *');
  const result = await runPagesReadModelCron(
    { cron: PAGES_READ_MODEL_CRON, scheduledTime: BASE },
    {},
    dependencies,
  );
  assert.equal(result.task.key, 'dashboard-history');
  assert.deepEqual(calls, [BASE]);
  assert.deepEqual(
    await runPagesReadModelCron({ cron: '*/5 * * * *', scheduledTime: BASE }, {}, dependencies),
    { skipped: true, reason: 'unsupported-pages-read-model-cron', cron: '*/5 * * * *' },
  );

  const worker = config('wrangler.pages-read-model.jsonc');
  assert.equal(worker.name, 'sh-pages-read-model');
  assert.equal(worker.main, 'src/pages-read-model-entry.js');
  assert.deepEqual(worker.triggers.crons, [PAGES_READ_MODEL_CRON]);
  assert.deepEqual(worker.d1_databases.map(({ binding }) => binding), ['BUDDIES_DB', 'MINUTE_DB', 'OTHER_DB']);
});

test('Pages read-model Worker surfaces single-task materialization failures', async () => {
  await assert.rejects(
    runPagesReadModelCron(
      { cron: PAGES_READ_MODEL_CRON, scheduledTime: BASE },
      {},
      {
        runTask: async () => ({
          skipped: false,
          task: { key: 'minute-facts-current' },
          failed: 1,
          responses: [{ key: 'minute-facts-current', ok: false, error: 'render failed' }],
        }),
      },
    ),
    (error) => error instanceof AggregateError
      && /Pages read-model task minute-facts-current failed/.test(error.message)
      && error.errors.some((item) => /minute-facts-current: render failed/.test(item.message)),
  );
});

test('consolidated monitor dispatches maintenance to Queue and preserves the Cron budget', async () => {
  const sent = [];
  const scheduledTime = BASE + 30 * 60_000;
  const env = {
    HOST_MONITOR_QUEUE: {
      async send(body, options) { sent.push({ body, options }); },
    },
  };
  const result = await runConsolidatedMonitorScheduled(
    { cron: OTHER_MONITOR_CRON, scheduledTime },
    env,
    {},
    {
      otherOptions: {
        dependencies: { buddy: async () => 'buddy' },
        recordSuccess: async () => {},
        healthApp: { invalidateHealthCache() {} },
      },
    },
  );

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, {
    message_type: MONITOR_MAINTENANCE_MESSAGE,
    message_version: 1,
    cron: ROLLUP_MAINTENANCE_CRON,
    scheduled_at: scheduledTime,
  });
  assert.deepEqual(sent[0].options, { contentType: 'json' });
  assert.equal(result.at(-1).task, 'maintenance');

  const calls = [];
  const message = {
    body: sent[0].body,
    ack() { calls.push('ack'); },
    retry() { calls.push('retry'); },
  };
  await runConsolidatedMonitorQueue(
    { messages: [message] },
    { BUDDIES_DB: {}, OTHER_DB: {} },
    {},
    {
      maintenanceDependencies: {
        applyStagger: async () => calls.push('stagger'),
        waitForCollector: async () => ({ ready: true }),
        runRollup: async () => { calls.push('rollup'); return 'rollup'; },
      },
    },
  );
  assert.deepEqual(calls, ['stagger', 'rollup', 'ack']);

  const worker = config('wrangler.other.jsonc');
  assert.equal(worker.name, 'sh-monitor-other');
  assert.equal(worker.main, 'src/other-entry.js');
  assert.deepEqual(worker.triggers.crons, [OTHER_MONITOR_CRON]);
  assert.equal(worker.vars.CRON_STAGGER_OTHER_MS, 25_000);
  assert.equal(worker.vars.COLLECTOR_PRIORITY_WAIT_MS, 15_000);
  assert.equal(worker.vars.SNAPSHOT_RETENTION_ENABLED, true);
});

test('maintenance path reports swallowed D1 failures as failed Queue retries', async () => {
  const events = [];
  const message = {
    body: {
      message_type: MONITOR_MAINTENANCE_MESSAGE,
      cron: SNAPSHOT_RETENTION_CRON,
      scheduled_at: BASE + 50 * 60_000,
    },
    ack() { events.push('ack'); },
    retry() { events.push('retry'); },
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    await runConsolidatedMonitorQueue(
      { messages: [message] },
      { BUDDIES_DB: {}, OTHER_DB: {} },
      {},
      {
        maintenanceDependencies: {
          applyStagger: async () => {},
          waitForCollector: async () => ({ ready: true }),
          pruneSnapshots: async () => ({ skipped: true, reason: 'retention-error', error: 'delete failed' }),
        },
      },
    );
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(events, ['retry']);
});

test('direct maintenance runner preserves collector gating', async () => {
  const skipped = await runMonitorMaintenanceCron(
    { cron: SNAPSHOT_RETENTION_CRON, scheduledTime: BASE + 50 * 60_000 },
    { BUDDIES_DB: {}, OTHER_DB: {} },
    {
      applyStagger: async () => {},
      waitForCollector: async () => ({ ready: false, reason: 'collector-not-ready', targetMinute: BASE }),
      pruneSnapshots: async () => assert.fail('retention must be gated'),
    },
  );
  assert.deepEqual(skipped, { skipped: true, reason: 'collector-not-ready', targetMinute: BASE });
});

test('other monitor reserves buddy46 stages and runs only one workload per tick', async () => {
  assert.equal(otherMonitorTask(BASE), 'buddy');
  assert.equal(otherMonitorTask(BASE + 5 * 60_000), 'buddy');
  assert.equal(otherMonitorTask(BASE + 10 * 60_000), 'prediction');
  assert.equal(otherMonitorTask(BASE + 15 * 60_000), 'buddy');
  assert.equal(otherMonitorTask(BASE + 20 * 60_000), 'officialNews');
  assert.equal(otherMonitorTask(BASE + 25 * 60_000), 'host');
  assert.equal(otherMonitorTask(BASE + 30 * 60_000), 'buddy');
  assert.equal(otherMonitorTask(BASE + 40 * 60_000), 'prediction');
  assert.equal(otherMonitorTask(BASE + 50 * 60_000), 'host');

  const calls = [];
  const dependencies = {
    buddy: async () => { calls.push('buddy'); return 'buddy'; },
    host: async () => { calls.push('host'); return 'host'; },
    officialNews: async () => { calls.push('officialNews'); return 'news'; },
    officialNewsDue: async () => true,
  };
  const buddyResult = await runOtherMonitorScheduled(
    { cron: OTHER_MONITOR_CRON, scheduledTime: BASE + 5 * 60_000 },
    {},
    {},
    dependencies,
  );
  assert.deepEqual(buddyResult, ['buddy']);
  assert.deepEqual(calls, ['buddy']);

  calls.length = 0;
  const dueNewsResult = await runOtherMonitorScheduled(
    { cron: OTHER_MONITOR_CRON, scheduledTime: BASE + 25 * 60_000 },
    {},
    {},
    dependencies,
  );
  assert.deepEqual(dueNewsResult, ['news']);
  assert.deepEqual(calls, ['officialNews']);

  const events = [];
  await runOtherMonitorCron(
    { cron: OTHER_MONITOR_CRON, scheduledTime: BASE + 10 * 60_000 },
    {},
    {},
    {
      dependencies: {
        prediction: async () => events.push('prediction'),
        officialNewsDue: async () => false,
      },
      recordSuccess: async () => events.push('heartbeat'),
      healthApp: { invalidateHealthCache: () => events.push('invalidate') },
    },
  );
  assert.deepEqual(events, ['prediction', 'heartbeat', 'invalidate']);
});

test('consolidated monitor rejects unknown schedules', async () => {
  assert.deepEqual(
    await runConsolidatedMonitorScheduled({ cron: '1 2 3 4 5' }, {}, {}),
    { skipped: true, reason: 'unsupported-consolidated-monitor-cron', cron: '1 2 3 4 5' },
  );
});

test('minute read-model Worker has the renamed single Queue owner', () => {
  const worker = config('wrangler.read-model.jsonc');
  assert.equal(worker.name, 'sh-minute-read-model');
  assert.equal(worker.queues.consumers.length, 1);
  assert.equal(worker.queues.consumers[0].queue, 'stationhead-read-model');
});
