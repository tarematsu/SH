import test from 'node:test';
import assert from 'node:assert/strict';

import { createShTrafficGuard } from '../worker/src/sh-traffic-guard.js';

test('traffic guard preserves null bodies for 204 responses and cached copies', async () => {
  let calls = 0;
  const guarded = createShTrafficGuard(async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  }, () => 120_000);
  const url = 'https://production1.stationhead.com/channels/alias/buddies';

  const first = await guarded(url);
  const cached = await guarded(url);

  assert.equal(first.status, 204);
  assert.equal(cached.status, 204);
  assert.equal(await first.text(), '');
  assert.equal(await cached.text(), '');
  assert.equal(calls, 1);
});
