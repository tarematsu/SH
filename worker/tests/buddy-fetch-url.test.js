import assert from 'node:assert/strict';
import test from 'node:test';

import { createBuddyGuardedFetch } from '../src/buddy-fetch-guard.js';

test('guarded fetch accepts a URL object', async () => {
  let seenUrl = null;
  const guarded = createBuddyGuardedFetch(async (input) => {
    seenUrl = new URL(String(input));
    return new Response(JSON.stringify({
      alias: 'buddy46',
      current_station: {
        is_broadcasting: true,
        queue: { queue_tracks: [] },
      },
    }), { status: 200 });
  }, 'buddy46');

  const response = await guarded(new URL('https://example.invalid/channels/alias/buddy46'));
  assert.equal(seenUrl.pathname, '/station/handle/buddy46/guest');
  assert.equal((await response.json()).alias, 'buddy46');
});
