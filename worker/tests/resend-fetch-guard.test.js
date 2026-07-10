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

test('concurrent Resend requests with the same idempotency key share one request', async () => {
  let calls = 0;
  let resolveFetch;
  const guarded = createOptionalFetchGuard(async () => {
    calls += 1;
    await new Promise((resolve) => { resolveFetch = resolve; });
    return Response.json({ id: 'email-1' }, { status: 200 });
  });

  const init = {
    method: 'POST',
    headers: { 'idempotency-key': 'same-key' },
    body: '{}',
  };
  const firstPromise = guarded('https://api.resend.com/emails', init);
  const secondPromise = guarded('https://api.resend.com/emails', init);
  await Promise.resolve();
  resolveFetch();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(calls, 1);
  assert.equal(first.headers.get('x-sh-resend-cache'), 'miss');
  assert.equal(second.headers.get('x-sh-resend-cache'), 'coalesced');
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
