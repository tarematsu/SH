import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FACTS_HISTORY_24H_SQL,
  FACTS_HISTORY_SINCE_SQL,
  FACTS_LATEST_SQL,
  FACTS_PREDICTION_24H_SQL,
} from '../functions/lib/dashboard-facts.js';

test('dashboard history omits playback counters that are no longer charted', () => {
  for (const sql of [FACTS_HISTORY_24H_SQL, FACTS_HISTORY_SINCE_SQL]) {
    assert.match(sql, /online_member_count/);
    assert.match(sql, /comment_velocity/);
    assert.doesNotMatch(sql, /reported_current_stream_count/);
    assert.doesNotMatch(sql, /current_stream_count/);
  }
});

test('latest metrics and goal prediction retain playback counters', () => {
  assert.match(FACTS_LATEST_SQL, /reported_current_stream_count AS current_stream_count/);
  assert.match(FACTS_PREDICTION_24H_SQL, /reported_current_stream_count/);
});
