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

test('production entry exposes only scheduled and queue handlers', () => {
  assert.deepEqual(Object.keys(worker).sort(), ['queue', 'scheduled']);
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

test('dispatch preserves task selection and idle behavior', async () => {
  assert.equal(pagesReadModelTask(BASE).key, 'dashboard-history');
  assert.equal(pagesReadModelTask(BASE + 60 * 60_000).kind, 'track-history-step');
  assert.equal(pagesReadModelTask(BASE + 176 * 60_000).kind, 'idle');
  const idle = await runDispatchedPagesReadModelTask({}, BASE + 176 * 60_000);
  assert.equal(idle.reason, 'six-hour-cycle-idle');
});

test('hot paths cache lazy modules and avoid success-path callback allocations', () => {
  assert.match(entrySource, /publicationModulePromise \|\|=/);
  assert.doesNotMatch(entrySource, /responses\.filter\(/);
  assert.doesNotMatch(entrySource, /failures\.map\(/);
  assert.match(dispatchSource, /trackHistoryModulePromise \|\|=/);
  assert.match(dispatchSource, /sixHourModulePromise \|\|=/);
  assert.match(dispatchSource, /switch \(cycleMinute\)/);
  assert.doesNotMatch(dispatchSource, /new Map\(/);
  assert.doesNotMatch(dispatchSource, /new Date\(cycleStart\)/);
});
