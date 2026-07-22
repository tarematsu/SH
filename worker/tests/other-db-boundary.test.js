import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { STREAM_GOAL_PREDICTION_AGGREGATE_SQL } from '../src/stream-goal-prediction.js';
import { OFFICIAL_PROBE_CONTEXT_SQL } from '../src/official-news-probe.js';

const OWNED = [
  'official-news-probe.js',
  'official-news-reconcile.js',
  'stream-goal-prediction.js',
  'snapshot-retention.js',
  'sakurazaka-monitor.js',
];

test('OTHER_DB-owned modules do not fall back to an ambiguous env.DB binding', () => {
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

test('official probing resolves the dedicated Sakurazaka authentication state', () => {
  const source = readFileSync(new URL('../src/official-news-probe.js', import.meta.url), 'utf8');
  assert.match(OFFICIAL_PROBE_CONTEXT_SQL, /WHERE id=\?/);
  assert.match(source, /SAKURAZAKA_AUTH_STATE_ID/);
  assert.match(source, /sakurazaka46jp/);
});
