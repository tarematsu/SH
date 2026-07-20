import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  OTHER_WORKER_CRON,
  otherProductionTask,
  otherStaggerApplies,
  runOfficialNewsWithReconcile,
  runOtherCron,
  runOtherScheduled,
} from '../src/other-entry.js';

test('other scheduling runs all injected compatibility tasks', async () => {
  const calls = [];
  const controller = { scheduledTime: 300_000, cron: '* * * * *' };
  const env = { marker: true };
  const ctx = { waitUntil() {} };

  const results = await runOtherScheduled(controller, env, ctx, {
    buddy: (receivedEnv, receivedCtx, now) => {
      calls.push(['buddy', receivedEnv, receivedCtx, now]);
      return 'buddy-done';
    },
    host: (receivedEnv) => {
      calls.push(['host', receivedEnv]);
      return 'host-done';
    },
    prediction: (receivedEnv, now) => {
      calls.push(['prediction', receivedEnv, now]);
      return 'prediction-done';
    },
    maintenance: (receivedEnv, now) => {
      calls.push(['maintenance', receivedEnv, now]);
      return 'maintenance-done';
    },
    officialNews: (receivedEnv, now) => {
      calls.push(['officialNews', receivedEnv, now]);
      return 'official-news-done';
    },
    snapshotRetention: (receivedEnv, now) => {
      calls.push(['snapshotRetention', receivedEnv, now]);
      return 'snapshot-retention-done';
    },
  });

  assert.deepEqual(results, [
    'buddy-done',
    'host-done',
    'prediction-done',
    'maintenance-done',
    'official-news-done',
    'snapshot-retention-done',
  ]);
  assert.deepEqual(calls.map((call) => call[0]), [
    'buddy',
    'host',
    'prediction',
    'maintenance',
    'officialNews',
    'snapshotRetention',
  ]);
  assert.equal(calls[0][1], env);
  assert.equal(calls[0][2], ctx);
  assert.equal(calls[0][3], 300_000);
});

test('other scheduling aggregates failures after remaining tasks run', async () => {
  const failure = new Error('prediction failed');
  const ran = { host: false, maintenance: false, officialNews: false, snapshotRetention: false };

  await assert.rejects(
    runOtherScheduled({ scheduledTime: 0 }, {}, { waitUntil() {} }, {
      buddy: () => 'buddy-done',
      host: () => { ran.host = true; return 'host-done'; },
      prediction: async () => { throw failure; },
      maintenance: () => { ran.maintenance = true; return 'maintenance-done'; },
      officialNews: () => { ran.officialNews = true; return 'official-news-done'; },
      snapshotRetention: () => { ran.snapshotRetention = true; return 'snapshot-retention-done'; },
    }),
    (error) => error instanceof AggregateError && error.errors.includes(failure),
  );

  assert.deepEqual(ran, {
    host: true,
    maintenance: true,
    officialNews: true,
    snapshotRetention: true,
  });
});

test('official news reconciliation follows only successful probes', async () => {
  const order = [];
  const env = {
    marker: true,
    DB: { prepare() { throw new Error('unused in this test'); } },
    OTHER_DB: { prepare() { throw new Error('unused in this test'); } },
  };
  const result = await runOfficialNewsWithReconcile(
    env,
    300_000,
    async (receivedEnv, _config, now) => {
      order.push('probe');
      assert.notEqual(receivedEnv, env);
      assert.equal(now, 300_000);
      return 'probe-done';
    },
    async (receivedEnv, now) => {
      order.push('reconcile');
      assert.equal(receivedEnv, env);
      assert.equal(now, 300_000);
    },
  );
  assert.equal(result, 'probe-done');
  assert.deepEqual(order, ['probe', 'reconcile']);

  let reconciled = false;
  const failure = new Error('probe failed');
  await assert.rejects(
    runOfficialNewsWithReconcile(
      env,
      300_000,
      async () => { throw failure; },
      async () => { reconciled = true; },
    ),
    failure,
  );
  assert.equal(reconciled, false);
});

test('runtime Worker configuration uses one-minute orchestration', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.runtime.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.name, 'sh-runtime-orchestrator');
  assert.equal(config.main, 'src/runtime-orchestrator-entry.js');
  assert.deepEqual(config.triggers?.crons, ['* * * * *']);
  assert.equal(config.vars?.PUBLIC_HEALTH_CACHE_MS, 60_000);
  assert.deepEqual(config.d1_databases.map(({ binding }) => binding), [
    'BUDDIES_DB',
    'MINUTE_DB',
    'OTHER_DB',
  ]);
});

test('other scheduling selects one workload for each five-minute slot', () => {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  const env = { BUDDY_PLAYBACK_INTERVAL_MS: 3 * 60 * 60_000 };

  assert.equal(otherProductionTask(base, env), 'buddy');
  assert.equal(otherProductionTask(base + 5 * 60_000, env), 'host');
  assert.equal(otherProductionTask(base + 10 * 60_000, env), 'prediction');
  assert.equal(otherProductionTask(base + 20 * 60_000, env), 'officialNews');
  assert.equal(otherProductionTask(base + 30 * 60_000, env), 'maintenance');
  assert.equal(otherProductionTask(base + 50 * 60_000, env), 'snapshotRetention');
  assert.equal(otherStaggerApplies({ cron: OTHER_WORKER_CRON, scheduledTime: base + 5 * 60_000 }, env), false);
  assert.equal(otherStaggerApplies({ cron: OTHER_WORKER_CRON, scheduledTime: base + 30 * 60_000 }, env), true);
  assert.equal(otherStaggerApplies({ cron: OTHER_WORKER_CRON, scheduledTime: base + 50 * 60_000 }, env), true);
});

test('other scheduling always invalidates public health cache', async () => {
  const events = [];
  const dependencies = Object.fromEntries(
    ['buddy', 'host', 'prediction', 'maintenance', 'officialNews', 'snapshotRetention']
      .map((name) => [name, () => events.push(name)]),
  );

  await runOtherCron({ scheduledTime: 0 }, {}, {}, {
    dependencies,
    stagger: async (_env, worker) => events.push(`stagger:${worker}`),
    healthApp: { invalidateHealthCache: () => events.push('invalidate') },
    recordSuccess: async () => events.push('heartbeat'),
  });
  assert.equal(events[0], 'stagger:other');
  assert.equal(events.at(-1), 'invalidate');

  let invalidated = false;
  await assert.rejects(runOtherCron({ scheduledTime: 0 }, {}, {}, {
    dependencies: {
      ...dependencies,
      host: async () => { throw new Error('host failed'); },
    },
    stagger: async () => {},
    healthApp: { invalidateHealthCache: () => { invalidated = true; } },
    recordFailure: async () => {},
  }), AggregateError);
  assert.equal(invalidated, true);
});
