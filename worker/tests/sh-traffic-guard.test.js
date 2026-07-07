import assert from 'node:assert/strict';
import test from 'node:test';

import { createSHTrafficGuard } from '../src/sh-traffic-guard.js';

const ORIGIN = 'https://production1.stationhead.com';

function okJson() {
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}

test('handle reads keep a reserved budget after data reads are exhausted', async () => {
  const calls = [];
  const guarded = createSHTrafficGuard(async (input) => {
    calls.push(new URL(String(input)).pathname);
    return okJson();
  }, () => 0);

  for (let index = 0; index < 10; index += 1) {
    const response = await guarded(`${ORIGIN}/channels/alias/buddies?sample=${index}`);
    assert.equal(response.status, 200);
  }

  const buddy = await guarded(`${ORIGIN}/station/handle/buddy46/guest`, {
    method: 'POST',
    body: '',
  });

  assert.equal(buddy.status, 200);
  assert.equal(calls.length, 11);
  assert.equal(calls.at(-1), '/station/handle/buddy46/guest');
});

test('handle reads have their own per-minute limit', async () => {
  const calls = [];
  const guarded = createSHTrafficGuard(async (input) => {
    calls.push(new URL(String(input)).pathname);
    return okJson();
  }, () => 0);

  assert.equal((await guarded(`${ORIGIN}/station/handle/buddy46/guest`, { method: 'POST', body: '' })).status, 200);
  assert.equal((await guarded(`${ORIGIN}/station/handle/sakurazaka46jp/guest`, { method: 'POST', body: '' })).status, 200);

  const blocked = await guarded(`${ORIGIN}/station/handle/third/guest`, {
    method: 'POST',
    body: '',
  });

  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('x-sh-traffic-guard'), 'station-minute-budget-exhausted');
  assert.deepEqual(calls, [
    '/station/handle/buddy46/guest',
    '/station/handle/sakurazaka46jp/guest',
  ]);
});
