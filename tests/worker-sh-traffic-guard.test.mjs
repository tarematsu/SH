import test from 'node:test';
import assert from 'node:assert/strict';

import { createSHTrafficGuard } from '../worker/src/sh-traffic-guard.js';

test('SH chat requests are capped at 50 and shared within a minute', async () => {
  let calls = 0;
  let requestedUrl = null;
  const guarded = createSHTrafficGuard(async (input) => {
    calls += 1;
    requestedUrl = String(input);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }, () => 120_000);

  const url = 'https://production1.stationhead.com/station/123/chatHistory?limit=100';
  const headers = { authorization: 'Bearer token', 'sth-device-uid': 'device' };
  const first = await guarded(url, { headers });
  const second = await guarded(url, { headers });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(calls, 1);
  assert.equal(new URL(requestedUrl).searchParams.get('limit'), '50');
});

test('SH response sharing never crosses authentication sessions', async () => {
  let calls = 0;
  const guarded = createSHTrafficGuard(async () => {
    calls += 1;
    return new Response(JSON.stringify({ calls }), { status: 200 });
  }, () => 120_000);
  const url = 'https://production1.stationhead.com/channels/alias/buddies';

  const first = await guarded(url, {
    headers: { authorization: 'Bearer first', 'sth-device-uid': 'device-a' },
  });
  const second = await guarded(url, {
    headers: { authorization: 'Bearer second', 'sth-device-uid': 'device-b' },
  });
  const repeated = await guarded(url, {
    headers: { authorization: 'Bearer first', 'sth-device-uid': 'device-a' },
  });

  assert.equal((await first.json()).calls, 1);
  assert.equal((await second.json()).calls, 2);
  assert.equal((await repeated.json()).calls, 1);
  assert.equal(calls, 2);
});

test('SH data traffic is limited to ten upstream requests per minute', async () => {
  let calls = 0;
  const guarded = createSHTrafficGuard(async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  }, () => 120_000);

  for (let index = 0; index < 10; index += 1) {
    const response = await guarded(`https://production1.stationhead.com/channels/alias/test-${index}`);
    assert.equal(response.status, 200);
  }

  const limited = await guarded('https://production1.stationhead.com/channels/alias/overflow');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('x-sh-traffic-guard'), 'minute-budget-exhausted');
  assert.equal(calls, 10);
});

test('authentication has a separate two-request budget after the data budget is exhausted', async () => {
  let calls = 0;
  const guarded = createSHTrafficGuard(async () => {
    calls += 1;
    return new Response('', { status: 200 });
  }, () => 120_000);

  for (let index = 0; index < 10; index += 1) {
    assert.equal((await guarded(`https://production1.stationhead.com/channels/alias/test-${index}`)).status, 200);
  }
  assert.equal((await guarded('https://production1.stationhead.com/web/token', { method: 'POST', body: '' })).status, 200);
  assert.equal((await guarded('https://production1.stationhead.com/web/guest/login', { method: 'POST', body: '' })).status, 200);

  const authLimited = await guarded('https://production1.stationhead.com/web/token', { method: 'POST', body: '' });
  assert.equal(authLimited.status, 429);
  assert.equal(authLimited.headers.get('x-sh-traffic-guard'), 'auth-minute-budget-exhausted');
  assert.equal(calls, 12);
});

test('failed SH routes enter a one-minute local backoff per session', async () => {
  let calls = 0;
  let now = 120_000;
  const guarded = createSHTrafficGuard(async () => {
    calls += 1;
    return new Response('busy', { status: 503 });
  }, () => now);

  const url = 'https://production1.stationhead.com/channels/alias/buddies';
  const firstSession = { headers: { authorization: 'Bearer first', 'sth-device-uid': 'device-a' } };
  const secondSession = { headers: { authorization: 'Bearer second', 'sth-device-uid': 'device-b' } };
  assert.equal((await guarded(url, firstSession)).status, 503);
  const backedOff = await guarded(url, firstSession);
  assert.equal(backedOff.status, 503);
  assert.equal(backedOff.headers.get('x-sh-traffic-guard'), 'temporary-backoff');
  assert.equal((await guarded(url, secondSession)).status, 503);
  assert.equal(calls, 2);

  now += 60_001;
  assert.equal((await guarded(url, firstSession)).status, 503);
  assert.equal(calls, 3);
});

test('unapproved SH routes never reach the network', async () => {
  let calls = 0;
  const guarded = createSHTrafficGuard(async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  });

  const response = await guarded('https://production1.stationhead.com/internal/unknown');
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('x-sh-traffic-guard'), 'route-not-allowed');
  assert.equal(calls, 0);
});
