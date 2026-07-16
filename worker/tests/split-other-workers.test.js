import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  PAGES_FAST_READ_MODEL_CRON,
  PAGES_FULL_READ_MODEL_CRON,
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

test('Pages read-model Worker separates fast materialization from full history refresh', async () => {
  const calls = [];
  const dependencies = {
    refreshFast: async (_env, now) => { calls.push(['fast', now]); return 'fast'; },
    refreshFull: async (_env, now) => { calls.push(['full', now]); return 'full'; },
  };

  assert.equal(await runPagesReadModelCron({ cron: PAGES_FAST_READ_MODEL_CRON, scheduledTime: BASE }, {}, dependencies), 'fast');
  assert.equal(await runPagesReadModelCron({ cron: PAGES_FULL_READ_MODEL_CRON, scheduledTime: BASE + 31 * 60_000 }, {}, dependencies), 'full');
  assert.deepEqual(calls, [['fast', BASE], ['full', BASE + 31 * 60_000]]);

  const worker = config('wrangler.pages-read-model.jsonc');
  assert.equal(worker.name, 'sh-pages-read-model');
  assert.equal(worker.main, 'src/pages-read-model-entry.js');
  assert.deepEqual(worker.triggers.crons, [PAGES_FAST_READ_MODEL_CRON, PAGES_FULL_READ_MODEL_CRON]);
  assert.deepEqual(worker.d1_databases.map(({ binding }) => binding), ['BUDDIES_DB', 'MINUTE_DB', 'OTHER_DB']);
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

test('other monitor owns only buddy playback, host, prediction and official news', async () => {
  assert.equal(otherMonitorTask(BASE), 'host');
  assert.equal(otherMonitorTask(BASE + 10 * 60_000), 'prediction');
  assert.equal(otherMonitorTask(BASE + 20 * 60_000), 'officialNews');
  assert.equal(otherMonitorTask(BASE + 30 * 60_000), 'host');
  assert.equal(otherMonitorTask(BASE + 50 * 60_000), 'host');

  const calls = [];
  const dependencies = {
    buddy: async () => { calls.push('buddy'); return 'buddy'; },
    host: async () => { calls.push('host'); return 'host'; },
    officialNews: async () => { calls.push('officialNews'); return 'news'; },
    officialNewsDue: async () => true,
  };
  const results = await runOtherMonitorScheduled(
    { cron: OTHER_MONITOR_CRON, scheduledTime: BASE + 5 * 60_000 },
    {},
    {},
    dependencies,
  );
  assert.deepEqual(results, ['buddy', 'news']);
  assert.deepEqual(calls, ['buddy', 'officialNews']);

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
  assert.equal(worker.vars.DATA_MAINTENANCE_ENABLED, undefined);
  assert.equal(worker.vars.SNAPSHOT_RETENTION_ENABLED, undefined);
});

test('minute read-model Worker has the renamed single Queue owner', () => {
  const worker = config('wrangler.read-model.jsonc');
  assert.equal(worker.name, 'sh-minute-read-model');
  assert.equal(worker.queues.consumers.length, 1);
  assert.equal(worker.queues.consumers[0].queue, 'stationhead-read-model');
});
