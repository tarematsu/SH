import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { STREAM_GOAL_PREDICTION_AGGREGATE_SQL } from '../src/stream-goal-prediction.js';
import { OFFICIAL_PROBE_CONTEXT_SQL } from '../src/official-news-probe.js';

const OWNED = [
  'buddy-playback.js', 'buddy-playback-metadata.js', 'cloud-host-monitor.js',
  'official-news-probe.js', 'official-news-reconcile.js', 'stream-goal-prediction.js',
  'scheduled-maintenance.js', 'snapshot-retention.js', 'other-health.js',
  'health-alert.js', 'optimized-health.js',
];

test('other-owned modules have no runtime env.DB dependency', () => {
  for (const file of OWNED) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /env\??\.DB\b/, file);
  }
});

test('stream-goal prediction reads minute facts and presentation read model', () => {
  assert.match(STREAM_GOAL_PREDICTION_AGGREGATE_SQL, /FROM sh_minute_facts AS f/);
  assert.match(STREAM_GOAL_PREDICTION_AGGREGATE_SQL, /sh_channel_read_model/);
  assert.doesNotMatch(STREAM_GOAL_PREDICTION_AGGREGATE_SQL, /sh_channel_snapshots/);
});

test('other uses its buddy46 session instead of assuming a primary collector row', () => {
  assert.match(OFFICIAL_PROBE_CONTEXT_SQL, /id='buddy46'/);
  assert.doesNotMatch(OFFICIAL_PROBE_CONTEXT_SQL, /id='stationhead'/);
});
