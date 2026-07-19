import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import worker, {
  PAGES_READ_MODEL_CRON,
  runPagesReadModelCron,
} from '../src/pages-read-model-entry.js';
import {
  pagesReadModelTask,
  runDispatchedPagesReadModelTask,
} from '../src/pages-read-model-dispatch.js';

const BASE = Date.UTC(2026, 6, 18, 0, 0, 0);
const entrySource = readFileSync(new URL('../src/pages-read-model-entry.js', import.meta.url), 'utf8');
const dispatchSource = readFileSync(new URL('../src/pages-read-model-dispatch.js', import.meta.url), 'utf8');

test('production entry exposes only internal fetch, scheduled, and queue handlers', () => {
  assert.deepEqual(Object.keys(worker).sort(), ['fetch', 'queue', 'scheduled']);
});

test('cron success and failure behavior is preserved', async () => {
  const success = { task: { key: 'dashboard-history' }, responses: [{ ok: true }], failed: 0 };
  assert.equal(await runPagesReadModelCron(
    { cron: PAGES_READ_MODEL_CRON, scheduledTime: BASE },
    {},
    { runTask: async () => success },
  ), success);

  await assert.rejects(
    runPagesReadModelCron(
      { cron: PAGES_READ_MODEL_CRON, scheduledTime: BASE },
      {},
      { runTask: async () => ({
        task: { key: 'minute-facts-current' },
        responses: [{ key: 'minute-facts-current', ok: false, error: 'render failed' }],
        failed: 1,
      }) },
    ),
    (error) => error instanceof AggregateError
      && error.errors.length === 1
      && /render failed/.test(error.errors[0].message),
  );
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

test('dispatch preserves task selection and background behavior', async () => {
  assert.equal(pagesReadModelTask(BASE).key, 'dashboard-history');
  assert.equal(pagesReadModelTask(BASE + 60 * 60_000).kind, 'track-history-step');
  assert.equal(pagesReadModelTask(BASE + 176 * 60_000).kind, 'idle');
  const idle = await runDispatchedPagesReadModelTask({}, BASE + 176 * 60_000);
  assert.equal(idle.reason, 'six-hour-cycle-idle');

  const sentinel = { ok: true };
  assert.equal(await runDispatchedPagesReadModelTask(
    { BUDDIES_DB: {}, MINUTE_DB: {} },
    BASE + 60 * 60_000,
    { runTrackHistoryStep: async () => sentinel },
  ), sentinel);
});

test('hot paths cache lazy modules and avoid eager fallback or task allocations', () => {
  assert.match(entrySource, /publicationModulePromise \|\|=/);
  assert.match(entrySource, /minuteReadModelModulePromise \|\|=/);
  assert.doesNotMatch(entrySource, /import \{ processReadModelBatch \}/);
  assert.doesNotMatch(entrySource, /responses\.filter\(/);
  assert.doesNotMatch(entrySource, /failures\.map\(/);
  assert.doesNotMatch(entrySource, /fallback = Date\.now\(\)/);
  assert.match(entrySource, /if \(cron !== PAGES_READ_MODEL_CRON\)/);
  assert.match(dispatchSource, /trackHistoryModulePromise \|\|=/);
  assert.match(dispatchSource, /sixHourModulePromise \|\|=/);
  assert.match(dispatchSource, /switch \(cycleMinute\)/);
  assert.doesNotMatch(dispatchSource, /new Map\(/);
  assert.doesNotMatch(dispatchSource, /new Date\(cycleStart\)/);
  assert.doesNotMatch(dispatchSource, /fallback = Date\.now\(\)/);
  assert.doesNotMatch(dispatchSource, /const task = pagesReadModelTaskAt\(timestamp\)/);
});
