import assert from 'node:assert/strict';
import test from 'node:test';

import { createOptionalFetchGuard } from '../src/fetch-guard.js';

const SPOTIFY_URL = 'https://open.spotify.com/oembed?url=track';
const RESEND_URL = 'https://api.resend.com/emails';

function deferredFetch() {
  const releases = [];
  let calls = 0;
  return {
    releases,
    get calls() { return calls; },
    fetch() {
      calls += 1;
      return new Promise((resolve) => releases.push(resolve));
    },
  };
}

test('concurrent optional GET misses do not share an in-flight fetch promise', async () => {
  const native = deferredFetch();
  const guarded = createOptionalFetchGuard(native.fetch.bind(native), () => 60_000);

  const firstPromise = guarded(SPOTIFY_URL);
  const secondPromise = guarded(SPOTIFY_URL);
  assert.equal(native.calls, 2);

  native.releases[0](Response.json({ request: 1 }));
  native.releases[1](Response.json({ request: 2 }));
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.deepEqual(await first.json(), { request: 1 });
  assert.deepEqual(await second.json(), { request: 2 });
});

test('concurrent Resend sends stay request-local and later success uses snapshot cache', async () => {
  const native = deferredFetch();
  const guarded = createOptionalFetchGuard(native.fetch.bind(native), () => 60_000);
  const init = {
    method: 'POST',
    headers: { 'idempotency-key': 'message-1' },
    body: JSON.stringify({ to: 'test@example.com' }),
  };

  const firstPromise = guarded(RESEND_URL, init);
  const secondPromise = guarded(RESEND_URL, init);
  assert.equal(native.calls, 2);

  native.releases[0](Response.json({ id: 'first' }));
  native.releases[1](Response.json({ id: 'second' }));
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(first.headers.get('x-sh-resend-cache'), 'miss');
  assert.equal(second.headers.get('x-sh-resend-cache'), 'miss');
  assert.deepEqual(await first.json(), { id: 'first' });
  assert.deepEqual(await second.json(), { id: 'second' });

  const cached = await guarded(RESEND_URL, init);
  assert.equal(native.calls, 2);
  assert.equal(cached.headers.get('x-sh-resend-cache'), 'hit');
  assert.deepEqual(await cached.json(), { id: 'second' });
});

test('optional failures retain timestamp backoff without retaining I/O promises', async () => {
  let calls = 0;
  const guarded = createOptionalFetchGuard(async () => {
    calls += 1;
    return new Response('temporary', { status: 503 });
  }, () => 60_000);

  assert.equal((await guarded(SPOTIFY_URL)).status, 503);
  const backedOff = await guarded(SPOTIFY_URL);
  assert.equal(backedOff.status, 503);
  assert.equal(backedOff.headers.get('x-sh-fetch-guard'), 'backoff:open.spotify.com');
  assert.equal(calls, 1);
});

test('HEAD and null-body statuses remain bodyless after snapshot reconstruction', async () => {
  const headGuard = createOptionalFetchGuard(
    async () => new Response(null, { status: 200, headers: { 'x-test': 'head' } }),
    () => 60_000,
  );
  const head = await headGuard(SPOTIFY_URL, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(head.headers.get('x-test'), 'head');

  const emptyGuard = createOptionalFetchGuard(
    async () => new Response(null, { status: 204, headers: { 'x-test': 'empty' } }),
    () => 60_000,
  );
  const empty = await emptyGuard(SPOTIFY_URL);
  assert.equal(empty.status, 204);
  assert.equal(empty.body, null);
  assert.equal(empty.headers.get('x-test'), 'empty');
});
