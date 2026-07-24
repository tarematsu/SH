import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  runSplitTrackHistoryCycleStep,
  trackHistoryCycleEnabled,
} from '../src/pages-track-history-split-cycle.js';

const NOW = Date.UTC(2026, 6, 24, 0, 30, 0);

test('production config disables automatic track-history materialization', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.runtime.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.vars.PAGES_TRACK_HISTORY_CYCLE_ENABLED, false);
});

test('track-history remains enabled when the flag is absent and accepts explicit true values', () => {
  assert.equal(trackHistoryCycleEnabled({}), true);
  assert.equal(trackHistoryCycleEnabled({ PAGES_TRACK_HISTORY_CYCLE_ENABLED: true }), true);
  assert.equal(trackHistoryCycleEnabled({ PAGES_TRACK_HISTORY_CYCLE_ENABLED: 'on' }), true);
});

test('disabled track-history returns before touching D1 or publication Queue bindings', async () => {
  const env = new Proxy({ PAGES_TRACK_HISTORY_CYCLE_ENABLED: false }, {
    get(target, property, receiver) {
      if (property === 'BUDDIES_DB' || property === 'MINUTE_DB' || property === 'PAGES_READ_MODEL_QUEUE') {
        assert.fail(`disabled track-history must not inspect ${String(property)}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const result = await runSplitTrackHistoryCycleStep(env, NOW, {
    loadStage: async () => assert.fail('disabled track-history must not load stage state'),
    sendPublication: async () => assert.fail('disabled track-history must not enqueue publication'),
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'track-history-cycle-disabled');
  assert.equal(result.task.kind, 'track-history-idle');
  assert.equal(result.task.disabled_by, 'PAGES_TRACK_HISTORY_CYCLE_ENABLED');
  assert.equal(result.failed, 0);
});

test('false-like configured values disable the cycle', () => {
  for (const value of [false, 0, '0', 'false', 'no', 'off']) {
    assert.equal(trackHistoryCycleEnabled({ PAGES_TRACK_HISTORY_CYCLE_ENABLED: value }), false);
  }
});
