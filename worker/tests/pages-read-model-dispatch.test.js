import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pagesReadModelTask,
  runDispatchedPagesReadModelTask,
} from '../src/pages-read-model-dispatch.js';
import { pagesSixHourTask } from '../src/pages-six-hour-read-model.js';

const cycleStart = Date.UTC(2026, 6, 18, 0, 0, 0);

test('lightweight Pages dispatch preserves six-hour slot selection', () => {
  for (const minute of [0, 1, 35, 50, 59, 60, 70, 105, 140, 175, 210, 245, 246, 359]) {
    const now = cycleStart + minute * 60_000;
    assert.deepEqual(pagesReadModelTask(now), pagesSixHourTask(now));
  }
});

test('track-history minutes call only the injected shard runner', async () => {
  const calls = [];
  const now = cycleStart + 12 * 60_000;
  const result = await runDispatchedPagesReadModelTask({
    BUDDIES_DB: {},
    MINUTE_DB: {},
  }, now, {
    async runTrackHistoryStep(env, timestamp) {
      calls.push({ env, timestamp });
      return { skipped: false, task: { kind: 'track-history-shard' }, responses: [], failed: 0 };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].timestamp, now);
  assert.equal(result.task.kind, 'track-history-shard');
});

test('idle Pages minutes return without loading a materializer', async () => {
  const now = cycleStart + 61 * 60_000;
  const result = await runDispatchedPagesReadModelTask({}, now);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'six-hour-cycle-idle');
});
