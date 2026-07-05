import assert from 'node:assert/strict';
import test from 'node:test';

import { WEEKLY_LEADERBOARD_SOURCE_URL } from '../src/cloud-weekly-leaderboard.js';

test('weekly leaderboard uses the authenticated production API', () => {
  const url = new URL(WEEKLY_LEADERBOARD_SOURCE_URL);
  assert.equal(url.origin, 'https://production1.stationhead.com');
  assert.equal(url.pathname, '/weeklyLeaderboard');
});
