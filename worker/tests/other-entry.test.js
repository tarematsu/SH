import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import otherApp, { runOfficialNewsWithReconcile, runOtherScheduled } from '../src/other-entry.js';

test('other worker scheduled run drives buddy playback, host, prediction, maintenance, official news, and snapshot retention', async () => {
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

  assert.deepEqual(
    results,
    ['buddy-done', 'host-done', 'prediction-done', 'maintenance-done', 'official-news-done', 'snapshot-retention-done'],
  );
  assert.equal(calls.length, 6);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['buddy', 'host', 'prediction', 'maintenance', 'officialNews', 'snapshotRetention'],
  );
  assert.equal(calls[0][1], env);
  assert.equal(calls[0][2], ctx);
  assert.equal(calls[0][3], 300_000);
});

test('other worker scheduled run reports failures without stopping the remaining tasks', async () => {
  const failure = new Error('prediction failed');
  const ran = { host: false, prediction: false, maintenance: false, officialNews: false, snapshotRetention: false };

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

  assert.equal(ran.host, true);
  assert.equal(ran.maintenance, true);
  assert.equal(ran.officialNews, true);
  assert.equal(ran.snapshotRetention, true);
});

test('official news reconcile runs only after a successful probe', async () => {
  const order = [];
  const env = {
    marker: true,
    DB: { prepare() { throw new Error('unused in this test'); } },
    OTHER_DB: { prepare() { throw new Error('unused in this test'); } },
  };

  const result = await runOfficialNewsWithReconcile(
    env,
    300_000,
    async (receivedEnv, config, now) => {
      order.push('probe');
      assert.notEqual(receivedEnv, env, 'expected the probe to receive the D1-optimized env wrapper');
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
});

test('official news reconcile is skipped when the probe fails', async () => {
  const failure = new Error('probe failed');
  let reconciled = false;

  await assert.rejects(
    runOfficialNewsWithReconcile(
      { marker: true },
      300_000,
      async () => { throw failure; },
      async () => { reconciled = true; },
    ),
    failure,
  );

  assert.equal(reconciled, false);
});

test('other worker Wrangler configuration deploys every minute against a shared D1 binding', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.other.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.name, 'sh-monitor-other');
  assert.equal(config.main, 'src/other-entry.js');
  assert.deepEqual(config.triggers?.crons, ['* * * * *']);
});

test('other worker owns the public health endpoint', async () => {
  const now = Date.now();
  function dbFor(kind) {
    return {
      prepare(sql) {
        return {
          bind() { return this; },
          async first() {
            if (kind === 'other' && sql.includes('sh_official_news_monitor_state')) {
              return { last_check_at: now, last_success_at: now, upcoming_count: 1, active_count: 0 };
            }
            if (kind === 'other' && sql.includes('sh_cloud_host_monitor_state')) {
              return { phase: 'idle', last_success_at: now };
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

  const env = { DB: dbFor('primary'), OTHER_DB: dbFor('other') };
  const response = await otherApp.fetch(new Request('https://other.test/health'), env, {});
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.collector_health_ok, true);
  assert.equal(payload.official_news_upcoming_count, 1);
  assert.equal(payload.cloud_solo_phase, 'idle');
  assert.equal((await otherApp.fetch(new Request('https://other.test/run', { method: 'POST' }), env, {})).status, 404);
});
