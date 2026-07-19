import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import otherApp, {
  OTHER_WORKER_CRON,
  otherProductionTask,
  otherStaggerApplies,
  runOfficialNewsWithReconcile,
  runOtherCron,
  runOtherScheduled,
} from '../src/other-entry.js';
import { createOtherHealthApp } from '../src/other-health.js';

function healthyPrimaryDb(now = Date.now()) {
  return {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (sql.includes('sh_collector_read_model')) {
            return { last_run_at: now, last_success_at: now, last_error_present: 0, updated_at: now };
          }
          if (sql.includes('FROM sh_minute_facts')) {
            return { channel_id: 318, station_id: 123, observed_at: now };
          }
          return null;
        },
      };
    },
  };
}

function healthyOtherDb(now = Date.now()) {
  return {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (sql.includes('sh_official_news_monitor_state')) {
            return { last_check_at: now, last_success_at: now, upcoming_count: 1, active_count: 0 };
          }
          if (sql.includes('sh_cloud_host_monitor_state')) {
            return { phase: 'idle', last_success_at: now };
          }
          if (sql.includes('sh_collector_status')) {
            return { status: 'ok', last_attempt_at: now, last_success_at: now };
          }
          if (sql.includes('collector_state.auth_token')) {
            return {
              auth_token: 'token',
              device_uid: 'device',
              collector_last_run_at: now,
              collector_last_success_at: now,
              collector_updated_at: now,
              control_id: 'stationhead',
              last_success_at: now,
            };
          }
          if (sql.includes('sh_health_alert_state')) {
            return {
              last_run_at: now,
              last_success_at: now,
              alert_table_ready: true,
              delivery_table_ready: true,
            };
          }
          return null;
        },
      };
    },
  };
}

test('legacy scheduled runner still drives the injected monitor task set', async () => {
  const calls = [];
  const controller = { scheduledTime: 300_000, cron: '* * * * *' };
  const env = { marker: true };
  const ctx = { waitUntil() {} };

  const results = await runOtherScheduled(controller, env, ctx, {
    buddy: (_env, _ctx, now) => { calls.push(['buddy', now]); return 'buddy-done'; },
    host: () => { calls.push(['host']); return 'host-done'; },
    prediction: () => { calls.push(['prediction']); return 'prediction-done'; },
    maintenance: () => { calls.push(['maintenance']); return 'maintenance-done'; },
    officialNews: () => { calls.push(['officialNews']); return 'official-news-done'; },
    snapshotRetention: () => { calls.push(['snapshotRetention']); return 'snapshot-retention-done'; },
  });

  assert.deepEqual(results, [
    'buddy-done',
    'host-done',
    'prediction-done',
    'maintenance-done',
    'official-news-done',
    'snapshot-retention-done',
  ]);
  assert.deepEqual(calls.map(([name]) => name), [
    'buddy',
    'host',
    'prediction',
    'maintenance',
    'officialNews',
    'snapshotRetention',
  ]);
});

test('legacy scheduled runner reports failures after allowing sibling tasks to finish', async () => {
  const failure = new Error('prediction failed');
  const calls = [];
  await assert.rejects(
    runOtherScheduled({ scheduledTime: 0, cron: '* * * * *' }, {}, { waitUntil() {} }, {
      buddy: () => calls.push('buddy'),
      host: () => calls.push('host'),
      prediction: async () => { throw failure; },
      maintenance: () => calls.push('maintenance'),
      officialNews: () => calls.push('officialNews'),
      snapshotRetention: () => calls.push('snapshotRetention'),
    }),
    (error) => error instanceof AggregateError && error.errors.includes(failure),
  );
  assert.deepEqual(calls, ['buddy', 'host', 'maintenance', 'officialNews', 'snapshotRetention']);
});

test('official news reconcile runs only after a successful probe', async () => {
  const order = [];
  const env = { DB: {}, OTHER_DB: {} };
  const result = await runOfficialNewsWithReconcile(
    env,
    300_000,
    async () => { order.push('probe'); return 'probe-done'; },
    async () => { order.push('reconcile'); },
  );
  assert.equal(result, 'probe-done');
  assert.deepEqual(order, ['probe', 'reconcile']);

  order.length = 0;
  await assert.rejects(
    runOfficialNewsWithReconcile(
      env,
      300_000,
      async () => { order.push('probe'); throw new Error('probe failed'); },
      async () => { order.push('reconcile'); },
    ),
    /probe failed/,
  );
  assert.deepEqual(order, ['probe']);
});

test('consolidated Wrangler configuration uses one every-minute cron', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.other.jsonc', import.meta.url), 'utf8'));
  assert.equal(OTHER_WORKER_CRON, '*/5 * * * *');
  assert.equal(config.name, 'sh-monitor-other');
  assert.equal(config.main, 'src/other-entry.js');
  assert.deepEqual(config.triggers?.crons, ['* * * * *']);
  assert.equal(config.vars?.PUBLIC_HEALTH_CACHE_MS, 60_000);
  assert.deepEqual(config.d1_databases.map(({ binding }) => binding), ['BUDDIES_DB', 'MINUTE_DB', 'OTHER_DB']);
  assert.equal(config.queues.producers.some(({ binding }) => binding === 'RAW_COLLECTION_QUEUE'), true);
});

test('legacy task selection keeps one workload per five-minute due slot', () => {
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
});

test('legacy cron invalidates health cache on success and failure', async () => {
  const success = [];
  const dependencies = Object.fromEntries(
    ['buddy', 'host', 'prediction', 'maintenance', 'officialNews', 'snapshotRetention']
      .map((name) => [name, () => success.push(name)]),
  );
  await runOtherCron({ scheduledTime: 0, cron: OTHER_WORKER_CRON }, {}, {}, {
    dependencies,
    stagger: async () => success.push('stagger'),
    healthApp: { invalidateHealthCache: () => success.push('invalidate') },
    recordSuccess: async () => success.push('heartbeat'),
  });
  assert.equal(success.at(-1), 'invalidate');

  let invalidated = false;
  await assert.rejects(runOtherCron({ scheduledTime: 0, cron: OTHER_WORKER_CRON }, {}, {}, {
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

test('consolidated other Worker owns the public health endpoint', async () => {
  const now = Date.now();
  const env = { MINUTE_DB: healthyPrimaryDb(now), OTHER_DB: healthyOtherDb(now) };
  const response = await otherApp.fetch(new Request('https://other.test/health'), env, {});
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.collector_health_ok, true);
  assert.equal(payload.official_news_upcoming_count, 1);
  assert.equal(payload.cloud_solo_phase, 'idle');
  assert.equal((await otherApp.fetch(new Request('https://other.test/run', { method: 'POST' }), env, {})).status, 404);
});

test('other health reports missing or failed bindings as unavailable JSON', async () => {
  const app = createOtherHealthApp();
  const missing = await app.fetch(new Request('https://other.test/health'), {
    MINUTE_DB: healthyPrimaryDb(),
  }, {});
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).other_health_ok, false);

  const originalError = console.error;
  console.error = () => {};
  try {
    const failed = await app.fetch(new Request('https://other.test/health'), {
      MINUTE_DB: { prepare() { throw new Error('primary D1 unavailable'); } },
      OTHER_DB: healthyOtherDb(),
    }, {});
    const payload = await failed.json();
    assert.equal(failed.status, 503);
    assert.equal(payload.primary_health_error_present, true);
  } finally {
    console.error = originalError;
  }
});
