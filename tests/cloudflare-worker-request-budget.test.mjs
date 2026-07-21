import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ACTIVE_CONFIGS,
  CONTINUATION_RESERVE_PER_DAY,
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

test('continuation-heavy and isolated runtime queues are counted', () => {
  assert.equal(QUEUE_MESSAGES_PER_DAY['stationhead-buddies-persist'], 10_080);
  assert.equal(QUEUE_MESSAGES_PER_DAY['stationhead-buddy-playback'], 144);
  assert.equal(QUEUE_MESSAGES_PER_DAY['stationhead-host-monitor'], 4_932);
  assert.equal(QUEUE_MESSAGES_PER_DAY['stationhead-minute-live-derive'], 5_760);
  assert.equal(QUEUE_MESSAGES_PER_DAY['stationhead-minute-enrichment'], 7_200);
  assert.equal(CONTINUATION_RESERVE_PER_DAY, 5_000);
  assert.equal(TARGET_DAILY_REQUESTS, 80_000);
});

test('the active topology is deduplicated and stays below 80000 requests per day', async () => {
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
  assert.equal(report.queue_consumer_requests, 38_628);
  assert.equal(report.scheduled_requests, 2_880);
  assert.equal(report.continuation_and_burst_reserve, 5_000);
  assert.equal(report.estimated_daily_requests, 71_508);
  assert.equal(report.headroom, 8_492);
  assert.ok(report.estimated_daily_requests < TARGET_DAILY_REQUESTS);
  assert.deepEqual(report.workers.map(({ name }) => name), [
    'sh-minute-enrichment',
    'sh-buddies-ingest',
    'sh-runtime-orchestrator',
  ]);
});
