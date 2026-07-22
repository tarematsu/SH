import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import worker, {
  PAGES_READ_MODEL_CRON,
  PAGES_READ_MODEL_DISPATCH_MESSAGE,
  pagesVariantDispatchDue,
  runPagesReadModelCron,
  runPagesReadModelQueue,
} from '../src/pages-read-model-entry.js';
import {
  pagesReadModelTask,
  runDispatchedPagesReadModelTask,
} from '../src/pages-read-model-dispatch.js';

const BASE = Date.UTC(2026, 6, 18, 0, 0, 0);
const entrySource = readFileSync(new URL('../src/pages-read-model-entry.js', import.meta.url), 'utf8');
const dispatchSource = readFileSync(new URL('../src/pages-read-model-dispatch.js', import.meta.url), 'utf8');

 test('production entry exposes internal fetch, scheduled, and queue handlers', () => {
  assert.deepEqual(Object.keys(worker).sort(), ['fetch', 'queue', 'scheduled']);
});

test('cron success and failure behavior is preserved for injected canonical tasks', async () => {
  const success = { task: { key: 'history:daily' }, responses: [{ ok: true }], failed: 0 };
  assert.equal(await runPagesReadModelCron(
    { cron: PAGES_READ_MODEL_CRON, scheduledTime: BASE + 35 * 60_000 },
    {},
    { runTask: async () => success },
  ), success);

  await assert.rejects(
    runPagesReadModelCron(
      { cron: PAGES_READ_MODEL_CRON, scheduledTime: BASE + 70 * 60_000 },
      {},
      { runTask: async () => ({
        task: { key: 'history:weekly' },
        responses: [{ key: 'history:weekly', ok: false, error: 'render failed' }],
        failed: 1,
      }) },
    ),
    (error) => error instanceof AggregateError
      && error.errors.length === 1
      && /render failed/.test(error.errors[0].message),
  );
});

test('production cron dispatches only heavy variant slots through the existing Pages Queue', async () => {
  const sent = [];
  const timestamp = BASE + 35 * 60_000;
  const result = await runPagesReadModelCron(
    { cron: PAGES_READ_MODEL_CRON, scheduledTime: timestamp },
    {
      PAGES_READ_MODEL_QUEUE: {
        async send(body, options) { sent.push({ body, options }); },
      },
    },
  );

  assert.equal(pagesVariantDispatchDue(timestamp), true);
  assert.equal(pagesVariantDispatchDue(BASE + 36 * 60_000), false);
  assert.equal(pagesVariantDispatchDue(BASE + 395 * 60_000), true);
  assert.equal(pagesVariantDispatchDue(BASE + 410 * 60_000), false);
  assert.deepEqual(result, {
    dispatched: true,
    task: 'pages-read-model-variant',
    scheduled_at: timestamp,
  });
  assert.deepEqual(sent, [{
    body: {
      message_type: PAGES_READ_MODEL_DISPATCH_MESSAGE,
      message_version: 1,
      scheduled_at: timestamp,
    },
    options: { contentType: 'json' },
  }]);
});

test('Pages Queue executes a dispatched variant and acknowledges it', async () => {
  const timestamp = BASE + 35 * 60_000;
  let acknowledged = false;
  let retried = false;
  const result = await runPagesReadModelQueue({
    queue: 'stationhead-pages-read-model-publication',
    messages: [{
      body: {
        message_type: PAGES_READ_MODEL_DISPATCH_MESSAGE,
        message_version: 1,
        scheduled_at: timestamp,
      },
      ack() { acknowledged = true; },
      retry() { retried = true; },
    }],
  }, {}, {
    runTask: async (_env, now) => ({
      generated_at: now,
      task: { key: 'history:daily' },
      responses: [{ ok: true }],
      failed: 0,
    }),
  });

  assert.equal(result.generated_at, timestamp);
  assert.equal(acknowledged, true);
  assert.equal(retried, false);
});

test('cron retains coercion compatibility outside the primitive-string hot path', async () => {
  const success = { responses: [], failed: 0 };
  const boxedCron = new String(PAGES_READ_MODEL_CRON);
  assert.equal(await runPagesReadModelCron(
    { cron: boxedCron, scheduledTime: String(BASE) },
    {},
    { runTask: async (_env, now) => (assert.equal(now, BASE), success) },
  ), success);
  assert.deepEqual(await runPagesReadModelCron({ cron: 123 }, {}), {
    skipped: true,
    reason: 'unsupported-pages-read-model-cron',
    cron: '123',
  });
});

test('dispatch preserves canonical task selection and daily background behavior', async () => {
  assert.equal(pagesReadModelTask(BASE).kind, 'track-history-step');
  assert.equal(pagesReadModelTask(BASE + 35 * 60_000).key, 'history:daily');
  assert.equal(pagesReadModelTask(BASE + 395 * 60_000).key, 'history:daily');
  assert.equal(pagesReadModelTask(BASE + 410 * 60_000).kind, 'track-history-step');
  assert.equal(pagesReadModelTask(BASE + 1_436 * 60_000).kind, 'idle');
  const idle = await runDispatchedPagesReadModelTask({}, BASE + 1_436 * 60_000);
  assert.equal(idle.reason, 'pages-read-model-cycle-idle');

  const sentinel = { ok: true };
  assert.equal(await runDispatchedPagesReadModelTask(
    { BUDDIES_DB: {}, MINUTE_DB: {} },
    BASE + 600 * 60_000,
    { runTrackHistoryStep: async () => sentinel },
  ), sentinel);
});

test('hot paths preload recurring stages and cache only variant modules', () => {
  assert.match(entrySource, /from '\.\/pages-read-model-dispatch\.js'/);
  assert.match(entrySource, /from '\.\/pages-track-history-publication-queue\.js'/);
  assert.match(entrySource, /PAGES_CYCLE_MINUTES = 24 \* 60/);
  assert.match(entrySource, /VARIANT_CADENCE_MINUTES = 6 \* 60/);
  assert.doesNotMatch(entrySource, /responses\.filter\(/);
  assert.doesNotMatch(entrySource, /failures\.map\(/);
  assert.doesNotMatch(entrySource, /fallback = Date\.now\(\)/);
  assert.match(entrySource, /if \(cron !== PAGES_READ_MODEL_CRON\)/);
  assert.match(dispatchSource, /from '\.\/pages-track-history-split-cycle\.js'/);
  assert.match(dispatchSource, /variantModulePromise \|\|=/);
  assert.match(dispatchSource, /switch \(slotMinute\)/);
  assert.match(dispatchSource, /PAGES_CYCLE_MINUTES = 24 \* 60/);
  assert.doesNotMatch(dispatchSource, /new Map\(/);
  assert.doesNotMatch(dispatchSource, /new Date\(cycleStart\)/);
  assert.doesNotMatch(dispatchSource, /fallback = Date\.now\(\)/);
  assert.doesNotMatch(dispatchSource, /const task = pagesReadModelTaskAt\(timestamp\)/);
});
