import test from 'node:test';
import assert from 'node:assert/strict';

import { createOptionalFetchGuard } from '../src/fetch-guard.js';

test('successful Resend requests are reused by idempotency key for one hour', async () => {
  let calls = 0;
  let now = 1_000;
  const guarded = createOptionalFetchGuard(async () => {
    calls += 1;
    return Response.json({ id: `email-${calls}` }, { status: 200 });
  }, () => now);

  const send = () => guarded('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'stationhead-monitor-d1-hour-1',
    },
    body: JSON.stringify({ subject: 'test' }),
  });

  const first = await send();
  const second = await send();

  assert.equal(calls, 1);
  assert.equal(first.headers.get('x-sh-resend-cache'), 'miss');
  assert.equal(second.headers.get('x-sh-resend-cache'), 'hit');
  assert.deepEqual(await second.json(), { id: 'email-1' });

  now += 60 * 60_000 + 1;
  await send();
  assert.equal(calls, 2);
});

test('concurrent Resend requests stay request-local and reuse settled success later', async () => {
  let calls = 0;
  const releases = [];
  const guarded = createOptionalFetchGuard(() => {
    calls += 1;
    const request = calls;
    return new Promise((resolve) => {
      releases.push(() => resolve(Response.json({ id: `email-${request}` }, { status: 200 })));
    });
  });

  const init = {
    method: 'POST',
    headers: { 'idempotency-key': 'same-key' },
    body: '{}',
  };
  const firstPromise = guarded('https://api.resend.com/emails', init);
  const secondPromise = guarded('https://api.resend.com/emails', init);
  assert.equal(calls, 2);
  releases[0]();
  releases[1]();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(first.headers.get('x-sh-resend-cache'), 'miss');
  assert.equal(second.headers.get('x-sh-resend-cache'), 'miss');
  assert.deepEqual(await first.json(), { id: 'email-1' });
  assert.deepEqual(await second.json(), { id: 'email-2' });

  const cached = await guarded('https://api.resend.com/emails', init);
  assert.equal(calls, 2);
  assert.equal(cached.headers.get('x-sh-resend-cache'), 'hit');
  assert.deepEqual(await cached.json(), { id: 'email-2' });
});

test('failed Resend requests are not cached', async () => {
  let calls = 0;
  const guarded = createOptionalFetchGuard(async () => {
    calls += 1;
    return new Response('temporary error', { status: 500 });
  });

  const init = {
    method: 'POST',
    headers: { 'idempotency-key': 'retry-key' },
    body: '{}',
  };
  await guarded('https://api.resend.com/emails', init);
  await guarded('https://api.resend.com/emails', init);
  assert.equal(calls, 2);
});
