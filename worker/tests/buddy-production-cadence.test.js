import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  OTHER_WORKER_CRON,
  runOtherScheduled,
} from '../src/other-entry.js';

async function runAt(minute) {
  const calls = [];
  const scheduledTime = Date.UTC(2026, 0, 1, 0, minute, 0);
  const results = await runOtherScheduled(
    { cron: OTHER_WORKER_CRON, scheduledTime },
    { BUDDY_PLAYBACK_INTERVAL_MS: 300_000 },
    { waitUntil() {} },
    {
      buddy: (_env, _ctx, now) => {
        calls.push(['buddy', now]);
        return 'buddy-done';
      },
      pages: (_env, now) => {
        calls.push(['pages', now]);
        return 'pages-done';
      },
      host: () => {
        calls.push(['host']);
        return 'host-done';
      },
      officialNewsDue: async () => false,
    },
  );
  return { calls, results, scheduledTime };
}

test('legacy compatibility runner retains injected five-minute buddy cadence', async () => {
  const fivePast = await runAt(5);
  assert.deepEqual(fivePast.results, ['buddy-done', 'host-done']);
  assert.deepEqual(fivePast.calls, [
    ['buddy', fivePast.scheduledTime],
    ['host'],
  ]);

  const fifteenPast = await runAt(15);
  assert.deepEqual(fifteenPast.results, ['buddy-done', 'pages-done', 'host-done']);
  assert.deepEqual(fifteenPast.calls, [
    ['buddy', fifteenPast.scheduledTime],
    ['pages', fifteenPast.scheduledTime],
    ['host'],
  ]);
});

test('other-worker production config uses a 30-minute buddy cadence', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.other.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.vars.BUDDY_PLAYBACK_INTERVAL_MS, 1_800_000);
  assert.deepEqual(config.triggers.crons, [OTHER_WORKER_CRON]);
});
