import assert from 'node:assert/strict';
import test from 'node:test';

import { createShReadFetch } from '../src/sh-read-cache.js';

const URL = 'https://production1.stationhead.com/station/318/chatHistory?limit=50';
const INIT = {
  headers: {
    authorization: 'Bearer token',
    'sth-device-uid': 'device',
  },
};

test('settled Stationhead reads reuse plain response snapshots', async () => {
  let calls = 0;
  const wrapped = createShReadFetch(async () => {
    calls += 1;
    return new Response(JSON.stringify({ chats: [{ id: calls }] }), {
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer refreshed',
      },
    });
  }, () => 60_000);

  const first = await wrapped(URL, INIT);
  const second = await wrapped(URL, INIT);

  assert.equal(calls, 1);
  assert.notEqual(first, second);
  assert.deepEqual(await first.json(), { chats: [{ id: 1 }] });
  assert.deepEqual(await second.json(), { chats: [{ id: 1 }] });
  assert.equal(second.status, 200);
  assert.equal(second.statusText, 'OK');
  assert.equal(second.headers.get('authorization'), 'Bearer refreshed');
});

test('concurrent cache misses never share an in-flight Response across invocations', async () => {
  const releases = [];
  let calls = 0;
  const wrapped = createShReadFetch(() => {
    calls += 1;
    return new Promise((resolve) => releases.push(resolve));
  }, () => 60_000);

  const firstPromise = wrapped(URL, INIT);
  const secondPromise = wrapped(URL, INIT);
  assert.equal(calls, 2);

  releases[0](Response.json({ request: 1 }));
  releases[1](Response.json({ request: 2 }));
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.deepEqual(await first.json(), { request: 1 });
  assert.deepEqual(await second.json(), { request: 2 });
});

test('failed responses and minute changes do not reuse cached snapshots', async () => {
  let now = 60_000;
  let calls = 0;
  const wrapped = createShReadFetch(async () => {
    calls += 1;
    return calls <= 2
      ? new Response('temporary', { status: 503 })
      : Response.json({ call: calls });
  }, () => now);

  assert.equal((await wrapped(URL, INIT)).status, 503);
  assert.equal((await wrapped(URL, INIT)).status, 503);
  assert.equal(calls, 2);

  assert.deepEqual(await (await wrapped(URL, INIT)).json(), { call: 3 });
  assert.deepEqual(await (await wrapped(URL, INIT)).json(), { call: 3 });
  assert.equal(calls, 3);

  now = 120_000;
  assert.deepEqual(await (await wrapped(URL, INIT)).json(), { call: 4 });
  assert.equal(calls, 4);
});

test('a slow response from the previous minute cannot repopulate the new cache', async () => {
  let now = 60_000;
  let calls = 0;
  let release;
  const wrapped = createShReadFetch(() => {
    calls += 1;
    if (calls === 1) return new Promise((resolve) => { release = resolve; });
    return Promise.resolve(Response.json({ call: calls }));
  }, () => now);

  const previousMinute = wrapped(URL, INIT);
  now = 120_000;
  assert.deepEqual(await (await wrapped(URL, INIT)).json(), { call: 2 });
  release(Response.json({ call: 1 }));
  assert.deepEqual(await (await previousMinute).json(), { call: 1 });
  assert.deepEqual(await (await wrapped(URL, INIT)).json(), { call: 2 });
  assert.equal(calls, 2);
});

test('null-body statuses are reconstructed without an empty body', async () => {
  let calls = 0;
  const wrapped = createShReadFetch(async () => {
    calls += 1;
    return new Response(null, { status: 204, headers: { 'x-test': 'ok' } });
  }, () => 60_000);

  const first = await wrapped(URL, INIT);
  const second = await wrapped(URL, INIT);
  assert.equal(calls, 1);
  assert.equal(first.status, 204);
  assert.equal(second.status, 204);
  assert.equal(second.body, null);
  assert.equal(second.headers.get('x-test'), 'ok');
});
