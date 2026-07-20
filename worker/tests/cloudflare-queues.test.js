import assert from 'node:assert/strict';
import test from 'node:test';

import { npxExecutable } from '../scripts/cloudflare-queues.mjs';

test('Cloudflare Queue deployment resolves the Windows command shim', () => {
  assert.equal(npxExecutable('win32'), 'npx.cmd');
  assert.equal(npxExecutable('linux'), 'npx');
  assert.equal(npxExecutable('darwin'), 'npx');
});
