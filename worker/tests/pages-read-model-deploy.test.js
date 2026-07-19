import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deployPagesReadModel,
  ensurePagesResponseNamespace,
  namespaceIdFromList,
  pagesReadModelConfigWithNamespaceId,
} from '../scripts/deploy-pages-read-model.mjs';

const TITLE = 'sh-pages-read-model-pages-response-kv';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('namespace list lookup selects the exact Pages response namespace', () => {
  assert.equal(namespaceIdFromList({
    result: [
      { id: 'other', title: 'other' },
      { id: 'pages-id', title: TITLE },
    ],
  }), 'pages-id');
  assert.equal(namespaceIdFromList({ result: [] }), null);
});

test('existing KV namespace is reused without a create request', async () => {
  const requests = [];
  const namespace = await ensurePagesResponseNamespace({
    accountId: 'account',
    apiToken: 'token',
    fetch: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({ success: true, result: [{ id: 'existing-id', title: TITLE }] });
    },
  });

  assert.deepEqual(namespace, { id: 'existing-id', title: TITLE, created: false });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/storage\/kv\/namespaces\?/);
  assert.equal(requests[0].init.method, 'GET');
  assert.equal(requests[0].init.headers.authorization, 'Bearer token');
});

test('missing KV namespace is created exactly once', async () => {
  const methods = [];
  const namespace = await ensurePagesResponseNamespace({
    accountId: 'account',
    apiToken: 'token',
    fetch: async (_url, init) => {
      methods.push(init.method);
      if (init.method === 'GET') return jsonResponse({ success: true, result: [] });
      assert.deepEqual(JSON.parse(init.body), { title: TITLE });
      return jsonResponse({ success: true, result: { id: 'created-id', title: TITLE } });
    },
  });

  assert.deepEqual(namespace, { id: 'created-id', title: TITLE, created: true });
  assert.deepEqual(methods, ['GET', 'POST']);
});

test('deployment injects the resolved namespace id into an ephemeral Wrangler config', async () => {
  const writes = [];
  const deletions = [];
  const spawns = [];
  const source = JSON.stringify({
    name: 'sh-pages-read-model',
    main: 'src/pages-read-model-entry.js',
    kv_namespaces: [{ binding: 'PAGES_RESPONSE_KV' }],
  });

  const namespace = await deployPagesReadModel({
    workerRoot: '/tmp/pages-read-model-worker',
    sourceConfigPath: '/tmp/pages-read-model-worker/wrangler.pages-read-model.jsonc',
    accountId: 'account',
    apiToken: 'token',
    fetch: async () => jsonResponse({
      success: true,
      result: [{ id: 'resolved-id', title: TITLE }],
    }),
    readFileSync: () => source,
    writeFileSync: (path, content) => writes.push({ path, content }),
    unlinkSync: (path) => deletions.push(path),
    spawnSync: (command, args, options) => {
      spawns.push({ command, args, options });
      return { status: 0 };
    },
    args: ['--minify'],
  });

  assert.equal(namespace.id, 'resolved-id');
  assert.equal(writes.length, 1);
  const rendered = JSON.parse(writes[0].content);
  assert.equal(rendered.kv_namespaces[0].id, 'resolved-id');
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
  assert.deepEqual(spawns[0].args, ['deploy', '--config', writes[0].path, '--minify']);
  assert.equal(spawns[0].options.cwd, '/tmp/pages-read-model-worker');
  assert.deepEqual(deletions, [writes[0].path]);
});

test('config rendering rejects a missing binding instead of deploying unbound', () => {
  assert.throws(
    () => pagesReadModelConfigWithNamespaceId('{"kv_namespaces":[]}', 'id'),
    /PAGES_RESPONSE_KV binding is missing/,
  );
});
