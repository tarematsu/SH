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

test('maintenance Worker preserves stagger and collector-priority ordering', async () => {
  const calls = [];
  const buddies = { prepare() {} };
  const other = {};
  const env = { BUDDIES_DB: buddies, OTHER_DB: other };
  const result = await runMonitorMaintenanceCron(
    { cron: ROLLUP_MAINTENANCE_CRON, scheduledTime: BASE + 30 * 60_000 },
    env,
    {
      applyStagger: async (_env, worker) => calls.push(`stagger:${worker}`),
      waitForCollector: async () => { calls.push('collector'); return { ready: true }; },
      runRollup: async (sourceDb, targetDb, now) => {
        calls.push(['rollup', sourceDb, targetDb, now]);
        return 'rollup';
      },
    },
  );
  assert.equal(result, 'rollup');
  assert.equal(calls[0], 'stagger:other');
  assert.equal(calls[1], 'collector');
  assert.deepEqual(calls[2], ['rollup', buddies, other, BASE + 30 * 60_000]);

  const skipped = await runMonitorMaintenanceCron(
    { cron: SNAPSHOT_RETENTION_CRON, scheduledTime: BASE + 50 * 60_000 },
    env,
    {
      applyStagger: async () => {},
      waitForCollector: async () => ({ ready: false, reason: 'collector-not-ready', targetMinute: BASE }),
      pruneSnapshots: async () => assert.fail('retention must be gated'),
    },
  );
  assert.deepEqual(skipped, { skipped: true, reason: 'collector-not-ready', targetMinute: BASE });

  const worker = config('wrangler.monitor-maintenance.jsonc');
  assert.equal(worker.name, 'sh-monitor-maintenance');
  assert.deepEqual(worker.triggers.crons, [ROLLUP_MAINTENANCE_CRON, SNAPSHOT_RETENTION_CRON]);
  assert.equal(worker.vars.CRON_STAGGER_OTHER_MS, 25_000);
  assert.equal(worker.vars.COLLECTOR_PRIORITY_WAIT_MS, 15_000);
});

test('maintenance Worker reports swallowed D1 failures as failed Cron invocations', async () => {
  const env = { BUDDIES_DB: { prepare() {} }, OTHER_DB: {} };
  const common = {
    applyStagger: async () => {},
    waitForCollector: async () => ({ ready: true }),
  };

  await assert.rejects(
    runMonitorMaintenanceCron(
      { cron: ROLLUP_MAINTENANCE_CRON, scheduledTime: BASE + 30 * 60_000 },
      {},
      { applyStagger: async () => {} },
    ),
    /rollup maintenance failed: db-binding-missing/,
  );

  await assert.rejects(
    runMonitorMaintenanceCron(
      { cron: ROLLUP_MAINTENANCE_CRON, scheduledTime: BASE + 30 * 60_000 },
      env,
      {
        ...common,
        runRollup: async () => ({ skipped: true, reason: 'maintenance-error', error: 'D1 unavailable' }),
      },
    ),
    /rollup maintenance failed: D1 unavailable/,
  );

  await assert.rejects(
    runMonitorMaintenanceCron(
      { cron: SNAPSHOT_RETENTION_CRON, scheduledTime: BASE + 50 * 60_000 },
      env,
      {
        ...common,
        pruneSnapshots: async () => ({ skipped: true, reason: 'retention-error', error: 'delete failed' }),
      },
    ),
    /snapshot retention failed: delete failed/,
  );
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

  const worker = config('wrangler.other.jsonc');
  assert.equal(worker.name, 'sh-monitor-other');
  assert.equal(worker.main, 'src/other-entry.js');
  assert.deepEqual(worker.triggers.crons, [OTHER_MONITOR_CRON]);
  assert.equal(worker.vars.BUDDY_PLAYBACK_INTERVAL_MS, 1_800_000);
  assert.equal(worker.vars.BUDDY_PLAYBACK_METADATA_LIMIT, 1);
  assert.equal(worker.vars.DATA_MAINTENANCE_ENABLED, undefined);
  assert.equal(worker.vars.SNAPSHOT_RETENTION_ENABLED, undefined);
});

test('minute read-model Worker has the renamed single Queue owner', () => {
  const worker = config('wrangler.read-model.jsonc');
  assert.equal(worker.name, 'sh-minute-read-model');
  assert.equal(worker.queues.consumers.length, 1);
  assert.equal(worker.queues.consumers[0].queue, 'stationhead-read-model');
});
