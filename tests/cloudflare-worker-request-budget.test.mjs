import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ACTIVE_CONFIGS,
  CONTINUATION_RESERVE_PER_DAY,
  QUEUE_MESSAGES_PER_DAY,
  REQUEST_BUDGET_EXCLUDED_QUEUES,
  TARGET_DAILY_REQUESTS,
  calculateDailyRequestBudget,
  cronInvocationsPerDay,
} from '../scripts/cloudflare-worker-request-budget.mjs';

test('cron request estimates cover wildcard, interval and hourly list schedules', () => {
  assert.equal(cronInvocationsPerDay('* * * * *'), 1_440);
  assert.equal(cronInvocationsPerDay('*/5 * * * *'), 288);
  assert.equal(cronInvocationsPerDay('5,7,9 * * * *'), 72);
});

test('live queues remain counted while historical reconstruction is temporarily excluded', () => {
  assert.equal(QUEUE_MESSAGES_PER_DAY['stationhead-buddies-persist'], 10_080);
  assert.equal(QUEUE_MESSAGES_PER_DAY['stationhead-sakurazaka46jp'], 720);
  assert.equal(QUEUE_MESSAGES_PER_DAY['stationhead-host-monitor'], 2_256);
  assert.equal(QUEUE_MESSAGES_PER_DAY['stationhead-minute-live-derive'], 5_760);
  assert.equal(QUEUE_MESSAGES_PER_DAY['stationhead-minute-enrichment'], 7_200);
  assert.equal(QUEUE_MESSAGES_PER_DAY['stationhead-minute-derive'], undefined);
  assert.equal(QUEUE_MESSAGES_PER_DAY['stationhead-minute-rebuild'], undefined);
  assert.deepEqual(REQUEST_BUDGET_EXCLUDED_QUEUES, [
    'stationhead-minute-derive',
    'stationhead-minute-rebuild',
  ]);
  assert.equal(CONTINUATION_RESERVE_PER_DAY, 5_000);
  assert.equal(TARGET_DAILY_REQUESTS, 80_000);
});

test('the active topology stays below 80000 counted requests per day', async () => {
  assert.deepEqual(ACTIVE_CONFIGS, [
    'worker/wrangler.minute-enrichment.jsonc',
    'worker/wrangler.ingest.jsonc',
    'worker/wrangler.sakurazaka46jp.jsonc',
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
  assert.equal(report.queue_consumer_requests, 34_944);
  assert.equal(report.scheduled_requests, 3_168);
  assert.equal(report.continuation_and_burst_reserve, 5_000);
  assert.equal(report.estimated_daily_requests, 68_112);
  assert.equal(report.headroom, 11_888);
  assert.deepEqual(report.request_budget_excluded_queues, REQUEST_BUDGET_EXCLUDED_QUEUES);
  assert.ok(report.estimated_daily_requests < TARGET_DAILY_REQUESTS);
  assert.deepEqual(report.workers.map(({ name }) => name), [
    'sh-minute-enrichment',
    'sh-buddies-ingest',
    'sh-sakurazaka46jp',
    'sh-runtime-orchestrator',
  ]);
});
