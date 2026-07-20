import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ACTIVE_CONFIGS,
  QUEUE_MESSAGES_PER_DAY,
  TARGET_DAILY_REQUESTS,
  calculateDailyRequestBudget,
  cronInvocationsPerDay,
} from '../scripts/cloudflare-worker-request-budget.mjs';

test('cron request estimates cover wildcard, interval and hourly list schedules', () => {
  assert.equal(cronInvocationsPerDay('* * * * *'), 1_440);
  assert.equal(cronInvocationsPerDay('*/5 * * * *'), 288);
  assert.equal(cronInvocationsPerDay('5,7,9 * * * *'), 72);
});

test('the active topology is deduplicated and stays below the request budgets', async () => {
  assert.deepEqual(ACTIVE_CONFIGS, [
    'worker/wrangler.minute-enrichment.jsonc',
    'worker/wrangler.ingest.jsonc',
    'worker/wrangler.runtime.jsonc',
  ]);
  const configs = await Promise.all(ACTIVE_CONFIGS.map(async (path) => ({
    path,
    source: await readFile(new URL(`../${path}`, import.meta.url), 'utf8'),
  })));
  const report = calculateDailyRequestBudget({
    configs,
    queueMessages: QUEUE_MESSAGES_PER_DAY,
    pagesRequests: 25_000,
  });
  assert.equal(report.ok, true);
  assert.ok(report.estimated_daily_requests < TARGET_DAILY_REQUESTS);
  assert.ok(report.estimated_daily_requests < 80_000);
  assert.deepEqual(report.workers.map(({ name }) => name), [
    'sh-minute-enrichment',
    'sh-buddies-ingest',
    'sh-runtime-orchestrator',
  ]);
  assert.ok(report.headroom > 0);
});
