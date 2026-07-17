import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RENAMED_WORKERS,
  retireRenamedWorkers,
} from '../scripts/retire-renamed-workers.mjs';

test('renamed Worker retirement deletes each legacy script and tolerates 404', async () => {
  assert.deepEqual(RENAMED_WORKERS, [
    { legacy: 'sh-monitor-buddies', replacement: 'sh-buddies-monitor' },
    { legacy: 'sh-ingest-channel', replacement: 'sh-buddies-ingest' },
    { legacy: 'sh-comments', replacement: 'sh-buddies-comments' },
    { legacy: 'sh-buddies-read-model', replacement: 'sh-pages-read-model' },
  ]);

  const calls = [];
  const logs = [];
  const statuses = [200, 404, 204, 404];
  const summary = await retireRenamedWorkers({
    accountId: 'account-id',
    token: 'token-value',
    log: (line) => logs.push(line),
    fetch: async (url, options) => {
      const status = statuses[calls.length];
      calls.push({ url, options });
      return {
        status,
        ok: status >= 200 && status < 300,
        async text() { return ''; },
      };
    },
  });

  assert.deepEqual(summary, {
    retired: ['sh-monitor-buddies', 'sh-comments'],
    already_retired: ['sh-ingest-channel', 'sh-buddies-read-model'],
  });
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.options.method, 'DELETE');
    assert.equal(call.options.headers.Authorization, 'Bearer token-value');
    assert.match(call.url, /accounts\/account-id\/workers\/scripts\/sh-/);
  }
  assert.equal(logs.length, 4);
});

test('renamed Worker retirement surfaces Cloudflare deletion failures', async () => {
  await assert.rejects(
    retireRenamedWorkers({
      accountId: 'account-id',
      token: 'token-value',
      log: () => {},
      fetch: async () => ({
        status: 500,
        ok: false,
        async text() { return 'upstream failed'; },
      }),
    }),
    /failed to retire sh-monitor-buddies: 500 upstream failed/,
  );
});
