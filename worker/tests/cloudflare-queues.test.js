import assert from 'node:assert/strict';
import test from 'node:test';

import { wranglerCommand } from '../scripts/wrangler-command.mjs';

test('Cloudflare deployment invokes Wrangler through Node without command shims', () => {
  assert.deepEqual(
    wranglerCommand(['queues', 'list'], {
      nodeExecutable: 'node-test',
      scriptPath: 'wrangler-test.js',
    }),
    {
      executable: 'node-test',
      args: ['wrangler-test.js', 'queues', 'list'],
    },
  );
});
