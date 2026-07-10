import test from 'node:test';
import assert from 'node:assert/strict';

import { createOptionalFetchGuard } from '../worker/src/fetch-guard.js';

test('iTunes requests are blocked without contacting upstream', async () => {
  let calls = 0;
  const guarded = createOptionalFetchGuard(async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  });

  const response = await guarded('https://itunes.apple.com/search?term=test');
  assert.equal(response.status, 410);
  assert.equal(response.headers.get('x-sh-fetch-guard'), 'blocked:itunes.apple.com');
  assert.equal(calls, 0);
});

test('duplicate Spotify requests share one upstream subrequest', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const guarded = createOptionalFetchGuard(async () => {
    calls += 1;
    await gate;
    return new Response(JSON.stringify({ title: 'Track' }), { status: 200 });
  }, () => 1000);

  const first = guarded('https://open.spotify.com/oembed?url=track');
  const second = guarded('https://open.spotify.com/oembed?url=track');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();

  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
});

test('failed optional requests enter a five-minute local backoff', async () => {
  let calls = 0;
  let now = 1000;
  const guarded = createOptionalFetchGuard(async () => {
    calls += 1;
    return new Response('rate limited', { status: 429 });
  }, () => now);

  assert.equal((await guarded('https://open.spotify.com/oembed?url=track')).status, 429);
  const backedOff = await guarded('https://open.spotify.com/oembed?url=track');
  assert.equal(backedOff.status, 503);
  assert.match(backedOff.headers.get('x-sh-fetch-guard'), /^backoff:/);
  assert.equal(calls, 1);

  now += 5 * 60_000 + 1;
  assert.equal((await guarded('https://open.spotify.com/oembed?url=track')).status, 429);
  assert.equal(calls, 2);
});

test('core Stationhead requests bypass the optional-host guard', async () => {
  let calls = 0;
  const guarded = createOptionalFetchGuard(async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  });

  const response = await guarded('https://production1.stationhead.com/channels/alias/buddies');
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});
