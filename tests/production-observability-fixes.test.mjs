import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import deployedWorker, {
  RuntimeCoordinator,
  runFetchCoordinatedScheduled,
} from '../worker/src/runtime-orchestrator-deployed-entry.js';
import {
  TRACK_HISTORY_RESPONSE_MAX_CHUNKS,
} from '../worker/src/pages-track-history-response.js';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);

function pythonSelfTest(path) {
  const result = spawnSync('python3', [path, '--self-test'], {
    cwd: rootPath,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${path}\n${result.stdout}\n${result.stderr}`);
}

test('deployed runtime uses fetch-based Durable Object coordination', async () => {
  assert.deepEqual(Object.keys(deployedWorker).sort(), ['fetch', 'queue', 'scheduled']);
  const calls = [];
  const stub = {
    async fetch(_url, init) {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.action === 'claim') {
        return Response.json({ claimed: true, holder_id: 'holder-1', lease_until: 80_000 });
      }
      return Response.json({ released: true });
    },
  };
  const result = await runFetchCoordinatedScheduled(
    { cron: '* * * * *', scheduledTime: 123 },
    {},
    {},
    {
      stub,
      runDirect: async (_controller, env) => {
        assert.equal(env.PRIMARY_RUN_LOCK_ENABLED, false);
        return 'ok';
      },
    },
  );
  assert.equal(result, 'ok');
  assert.deepEqual(calls.map(({ action }) => action), ['claim', 'release']);

  const rows = new Map();
  const coordinator = new RuntimeCoordinator({
    storage: {
      async get(key) { return rows.get(key); },
      async put(key, value) { rows.set(key, value); },
    },
  });
  const claimed = await coordinator.fetch(new Request('https://internal/lease', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'claim',
      cron: '* * * * *',
      scheduledTime: 123,
      now: 1_000,
      leaseMs: 70_000,
    }),
  }));
  assert.equal(claimed.status, 200);
  assert.equal((await claimed.json()).claimed, true);

  const config = JSON.parse(readFileSync(
    new URL('../worker/wrangler.runtime.jsonc', import.meta.url),
    'utf8',
  ));
  assert.equal(config.main, 'src/runtime-orchestrator-deployed-entry.js');
});

test('track-history response capacity covers the production publication', () => {
  assert.equal(TRACK_HISTORY_RESPONSE_MAX_CHUNKS, 256);
  assert.ok(TRACK_HISTORY_RESPONSE_MAX_CHUNKS > 80);
});

test('Cloudflare audit compatibility wrappers pass offline self-tests', () => {
  pythonSelfTest('.github/scripts/audit-cloudflare-free-tier.py');
  pythonSelfTest('.github/scripts/audit-cloudflare-telemetry.py');
  pythonSelfTest('.github/scripts/audit-deployed-cloudflare-telemetry.py');

  const freeTier = readFileSync(
    new URL('../.github/scripts/audit-cloudflare-free-tier.py', import.meta.url),
    'utf8',
  );
  assert.match(freeTier, /per_page=50/);
  assert.doesNotMatch(freeTier, /per_page=100/);
  assert.match(freeTier, /namespaceId: \{namespace\}/);
  assert.match(freeTier, /doInvocations\{index\}/);
  assert.match(freeTier, /kvOperations\{index\}/);
  assert.match(freeTier, /dimensions \{ actionType \}/);
  assert.match(freeTier, /dimensions \{ date \}/);
  assert.match(freeTier, /dimensions \{ namespaceId/);
  assert.match(freeTier, /not in document/);

  const telemetry = readFileSync(
    new URL('../.github/scripts/audit-cloudflare-telemetry.py', import.meta.url),
    'utf8',
  );
  assert.match(telemetry, /exceededCpu/);
  assert.match(telemetry, /outcome in core\.OK_OUTCOMES/);
});
