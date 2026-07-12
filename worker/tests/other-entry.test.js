import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { runOtherScheduled } from '../src/other-entry.js';

test('other worker scheduled run drives buddy playback, host, prediction, and maintenance', async () => {
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
  });

  assert.deepEqual(results, ['buddy-done', 'host-done', 'prediction-done', 'maintenance-done']);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => call[0]), ['buddy', 'host', 'prediction', 'maintenance']);
  assert.equal(calls[0][1], env);
  assert.equal(calls[0][2], ctx);
  assert.equal(calls[0][3], 300_000);
});

test('other worker scheduled run reports failures without stopping the remaining tasks', async () => {
  const failure = new Error('prediction failed');
  const ran = { host: false, prediction: false, maintenance: false };

  await assert.rejects(
    runOtherScheduled({ scheduledTime: 0 }, {}, { waitUntil() {} }, {
      buddy: () => 'buddy-done',
      host: () => { ran.host = true; return 'host-done'; },
      prediction: async () => { throw failure; },
      maintenance: () => { ran.maintenance = true; return 'maintenance-done'; },
    }),
    (error) => error instanceof AggregateError && error.errors.includes(failure),
  );

  assert.equal(ran.host, true);
  assert.equal(ran.maintenance, true);
});

test('other worker Wrangler configuration deploys every minute against a shared D1 binding', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.other.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.name, 'sh-monitor-other');
  assert.equal(config.main, 'src/other-entry.js');
  assert.deepEqual(config.triggers?.crons, ['* * * * *']);
});
