import assert from 'node:assert/strict';
import test from 'node:test';

import { createBuddyGuardedFetch } from '../src/buddy-fetch-guard.js';

test('guarded fetch accepts a URL object', async () => {
  const response = new Response(JSON.stringify({
    alias: 'buddy46',
    current_station: {
      is_broadcasting: true,
      queue: { queue_tracks: [] },
    },
  }), { status: 200 });
  const guarded = createBuddyGuardedFetch(async () => response, 'buddy46');

  assert.equal(
    await guarded(new URL('https://example.invalid/channels/alias/buddy46')),
    response,
  );
});
