import test from 'node:test';
import assert from 'node:assert/strict';

import { createStationheadTrafficGuard } from '../worker/src/stationhead-traffic-guard.js';

test('Stationhead chat requests are capped at 20 and shared within a minute', async () => {
  let calls = 0;
  let requestedUrl = null;
  const guarded = createStationheadTrafficGuard(async (input) => {
    calls += 1;
    requestedUrl = String(input);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }, () => 120_000);

  const url = 'https://production1.stationhead.com/station/123/chatHistory?limit=100';
  const first = await guarded(url, { headers: { authorization: 'Bearer token' } });
  const second = await guarded(url, { headers: { authorization: 'Bearer token' } });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(calls, 1);
  assert.equal(new URL(requestedUrl).searchParams.get('limit'), '20');
});

test('Stationhead traffic is limited to ten upstream requests per minute', async () => {
  let calls = 0;
  const guarded = createStationheadTrafficGuard(async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  }, () => 120_000);

  for (let index = 0; index < 10; index += 1) {
    const response = await guarded(`https://production1.stationhead.com/channels/alias/test-${index}`);
    assert.equal(response.status, 200);
  }

  const limited = await guarded('https://production1.stationhead.com/channels/alias/overflow');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('x-stationhead-traffic-guard'), 'minute-budget-exhausted');
  assert.equal(calls, 10);
});

test('failed Stationhead routes enter a one-minute local backoff', async () => {
  let calls = 0;
  let now = 120_000;
  const guarded = createStationheadTrafficGuard(async () => {
    calls += 1;
    return new Response('busy', { status: 503 });
  }, () => now);

  const url = 'https://production1.stationhead.com/channels/alias/buddies';
  assert.equal((await guarded(url)).status, 503);
  const backedOff = await guarded(url);
  assert.equal(backedOff.status, 503);
  assert.equal(backedOff.headers.get('x-stationhead-traffic-guard'), 'temporary-backoff');
  assert.equal(calls, 1);

  now += 60_001;
  assert.equal((await guarded(url)).status, 503);
  assert.equal(calls, 2);
});

test('unapproved Stationhead routes never reach the network', async () => {
  let calls = 0;
  const guarded = createStationheadTrafficGuard(async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  });

  const response = await guarded('https://production1.stationhead.com/internal/unknown');
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('x-stationhead-traffic-guard'), 'route-not-allowed');
  assert.equal(calls, 0);
});

test('authentication routes remain available inside the budget', async () => {
  let calls = 0;
  const guarded = createStationheadTrafficGuard(async () => {
    calls += 1;
    return new Response('', { status: 200 });
  }, () => 120_000);

  assert.equal((await guarded('https://production1.stationhead.com/web/token', { method: 'POST', body: '' })).status, 200);
  assert.equal((await guarded('https://production1.stationhead.com/web/guest/login', { method: 'POST', body: '' })).status, 200);
  assert.equal(calls, 2);
});
