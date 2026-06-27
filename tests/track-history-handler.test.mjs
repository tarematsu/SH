import test from 'node:test';
import assert from 'node:assert/strict';

import { TRACK_HISTORY_SQL } from '../site/functions/lib/track-history-handler.js';

test('track history SQL does not drop rows after the last observation window', () => {
  assert.ok(TRACK_HISTORY_SQL.includes('WHERE p.played_at >= ? AND p.played_at < ?'));
  assert.ok(!TRACK_HISTORY_SQL.includes('queue_last_observed_at + 300000'));
});
