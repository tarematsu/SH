import assert from 'node:assert/strict';
import test from 'node:test';

test('importing the other worker does not install the buddies chat fallback', async () => {
  const runtimeFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('upstream failed', { status: 500 });
  };
  try {
    await import('../src/other-entry.js');
    const response = await globalThis.fetch('https://production1.stationhead.com/station/test/chatHistory?limit=50');
    assert.equal(response.status, 500);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = runtimeFetch;
  }
});
