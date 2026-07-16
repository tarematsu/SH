import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  OTHER_WORKER_CRON,
  runOtherScheduled,
} from '../src/other-entry.js';

test('buddy46 and public API responses refresh beside the selected task every five minutes', async () => {
  const calls = [];
  const scheduledTime = Date.UTC(2026, 0, 1, 0, 5, 0);
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

  assert.deepEqual(results, ['buddy-done', 'pages-done', 'host-done']);
  assert.deepEqual(calls, [
    ['buddy', scheduledTime],
    ['pages', scheduledTime],
    ['host'],
  ]);
});

test('other-worker production config uses five-minute buddy and API cadence', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.other.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.vars.BUDDY_PLAYBACK_INTERVAL_MS, 300_000);
  assert.deepEqual(config.triggers.crons, [OTHER_WORKER_CRON]);
});
