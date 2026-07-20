import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { pruneRetiredWorkers } from '../scripts/cloudflare-workers.mjs';

const source = readFileSync(
  new URL('../scripts/deploy-minute-enrichment.mjs', import.meta.url),
  'utf8',
);
const workerApi = readFileSync(
  new URL('../scripts/cloudflare-workers.mjs', import.meta.url),
  'utf8',
);

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function withWorkerApi(fetchImpl, run) {
  const originalFetch = globalThis.fetch;
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
  process.env.CLOUDFLARE_API_TOKEN = 'test-token';
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('CLOUDFLARE_ACCOUNT_ID', originalAccountId);
    restoreEnv('CLOUDFLARE_API_TOKEN', originalToken);
  }
}

test('metadata redeploy rollback preserves a pre-existing consolidated consumer', () => {
  assert.match(source, /consolidatedBefore: hasConsumer\(spec\.queue, consolidatedScript\)/);
  assert.match(source, /if \(!migration\.consolidatedBefore && hasConsumer\(migration\.queue, consolidatedScript\)\)/);
  assert.doesNotMatch(source, /capture: true, allowFailure: true/);
});

test('metadata retirement API calls have a bounded timeout', () => {
  assert.match(workerApi, /AbortSignal\.timeout\(20_000\)/);
});

test('retired Workers are not deleted while an active replacement is missing', async () => {
  const calls = [];
  await withWorkerApi(async (url, options = {}) => {
    const href = String(url);
    const method = options.method || 'GET';
    calls.push({ href, method });
    const missing = href.includes('/sh-minute-enrichment');
    return {
      ok: !missing,
      status: missing ? 404 : 200,
      async json() { return { success: !missing }; },
    };
  }, async () => {
    await assert.rejects(
      () => pruneRetiredWorkers(['sh-monitor-other']),
      /active Workers are missing: sh-minute-enrichment/,
    );
  });
  assert.equal(calls.some(({ method }) => method === 'DELETE'), false);
});

test('retired Workers are deleted after every active replacement is reachable', async () => {
  const calls = [];
  await withWorkerApi(async (url, options = {}) => {
    const href = String(url);
    const method = options.method || 'GET';
    calls.push({ href, method });
    const deletedWorkerVerification = method === 'GET' && href.endsWith('/sh-monitor-other');
    return {
      ok: !deletedWorkerVerification,
      status: deletedWorkerVerification ? 404 : 200,
      async json() { return { success: true }; },
    };
  }, () => pruneRetiredWorkers(['sh-monitor-other']));
  assert.deepEqual(calls.map(({ method }) => method), [
    'GET', 'GET', 'GET', 'DELETE', 'GET',
  ]);
});

test('metadata consolidation is validated against the strict 10 ms CPU contract', () => {
  const budget = readFileSync(
    new URL('../../.github/scripts/enforce-worker-cpu-budget.py', import.meta.url),
    'utf8',
  );
  assert.match(budget, /BUDGET_MS = 10\.0/);
  assert.match(budget, /"comparison": "less_than_or_equal"/);
  assert.match(budget, /"statistic": "max"/);
});

test('metadata consolidation composes with the merged paginated Pages KV deploy', () => {
  const pagesKv = readFileSync(
    new URL('../scripts/pages-response-kv-namespace.mjs', import.meta.url),
    'utf8',
  );
  assert.match(pagesKv, /NextContinuationToken|page=\$\{page\}/);
  assert.match(pagesKv, /NAMESPACE_PAGE_SIZE = 1000/);
});
