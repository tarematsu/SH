import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequestGet, onRequestOptions } from '../functions/api/playback.js';

for (const [method, handler] of [['GET', onRequestGet], ['OPTIONS', onRequestOptions]]) {
  test(`${method} /api/playback is retired in favor of dashboard`, async () => {
    const response = await handler({
      request: new Request('https://example.invalid/api/playback', { method }),
      env: {},
    });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      ok: false,
      error: 'playback endpoint retired; use /api/dashboard',
      replacement: '/api/dashboard',
    });
  });
}
