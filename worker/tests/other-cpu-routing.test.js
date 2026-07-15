import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OTHER_WORKER_CRON,
  officialNewsProbeDue,
  runOtherScheduled,
  selectOtherProductionTask,
} from '../src/other-entry.js';

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

test('active official-news windows preempt an ordinary host slot', async () => {
  const task = await selectOtherProductionTask(
    { cron: OTHER_WORKER_CRON, scheduledTime: BASE + 5 * 60_000 },
    {},
    { officialNewsDue: async () => true },
  );
  assert.equal(task, 'officialNews');
});

test('ordinary host slot remains host when no announcement is due', async () => {
  const task = await selectOtherProductionTask(
    { cron: OTHER_WORKER_CRON, scheduledTime: BASE + 5 * 60_000 },
    {},
    { officialNewsDue: async () => false },
  );
  assert.equal(task, 'host');
});

test('scheduled official-news refresh does not need a preliminary D1 due read', async () => {
  let checked = false;
  const task = await selectOtherProductionTask(
    { cron: OTHER_WORKER_CRON, scheduledTime: BASE + 20 * 60_000 },
    {},
    { officialNewsDue: async () => { checked = true; return false; } },
  );
  assert.equal(task, 'officialNews');
  assert.equal(checked, false);
});

test('production routing executes only official news while an event is due', async () => {
  const calls = [];
  const result = await runOtherScheduled(
    { cron: OTHER_WORKER_CRON, scheduledTime: BASE + 5 * 60_000 },
    {},
    {},
    {
      officialNewsDue: async () => true,
      officialNews: async () => { calls.push('officialNews'); return 'news'; },
      host: async () => { calls.push('host'); return 'host'; },
    },
  );
  assert.deepEqual(result, ['news']);
  assert.deepEqual(calls, ['officialNews']);
});

test('lightweight due query covers scheduled and active announcement windows', async () => {
  const binds = [];
  const env = {
    OFFICIAL_NEWS_EARLY_WINDOW_MS: 600_000,
    OFFICIAL_NEWS_LATE_WINDOW_MS: 5_400_000,
    OTHER_DB: {
      prepare(sql) {
        assert.match(sql, /status='active'/);
        return {
          bind(...values) { binds.push(...values); return this; },
          async first() { return { due: 1 }; },
        };
      },
    },
  };
  assert.equal(await officialNewsProbeDue(env, BASE), true);
  assert.deepEqual(binds, [BASE - 5_400_000, BASE + 600_000]);
});
