import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  STATUS_MARKER,
  buildIssueBody,
  overallOutcome,
  statusState,
} from '../.github/scripts/publish-cloudflare-observability-status.mjs';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);

test('observability status publisher passes its offline self-test', () => {
  const result = spawnSync('node', [
    '.github/scripts/publish-cloudflare-observability-status.mjs',
    '--self-test',
  ], {
    cwd: rootPath,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /self-test passed/);
});

test('observability status body is stable, sanitized, and fail-closed', () => {
  assert.equal(statusState('success'), 'success');
  assert.equal(statusState('skipped'), 'failure');
  assert.equal(overallOutcome({ daily: 'success', telemetry: 'success' }), 'success');
  assert.equal(overallOutcome({ daily: 'success', telemetry: 'unknown' }), 'failure');

  const body = buildIssueBody({
    generatedAt: '2026-07-23T01:00:00.000Z',
    targetSha: 'abcdef123456',
    mainSha: 'fedcba654321',
    runUrl: 'https://github.com/tarematsu/SH/actions/runs/123',
    trigger: 'schedule',
    outcomes: {
      policy: 'success',
      daily: 'success',
      freeTier: 'failure',
      contract: 'success',
      query: 'success',
      telemetry: 'success',
    },
    summaries: {
      daily: '## Daily usage\n\nD1 rows read: 10',
      freeTier: '## Included usage\n\nQueue operations: 20',
    },
    activeDeployments: {
      'sh-runtime-orchestrator': {
        deployment_id: 'deployment-123',
        version_ids: ['version-a'],
        created_on: '2026-07-23T00:55:00Z',
      },
    },
    recentMerges: [{
      number: 591,
      title: 'Deploy runtime after migrations',
      merge_commit_sha: 'merge-sha-591',
      merged_at: '2026-07-23T00:50:00Z',
    }],
  });

  assert.match(body, new RegExp(STATUS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(body, /\*\*Overall:\*\* failure/);
  assert.match(body, /\| freeTier \| failure \|/);
  assert.match(body, /Workflow source commit:\*\* `abcdef123456`/);
  assert.match(body, /Current main SHA:\*\* `fedcba654321`/);
  assert.match(body, /deployment-123/);
  assert.match(body, /version-a/);
  assert.match(body, /#591 Deploy runtime after migrations/);
  assert.match(body, /Queue operations: 20/);
});

test('observability workflow publishes retrievable commit statuses and issue summary', async () => {
  const workflow = await readFile(
    new URL('.github/workflows/fetch-cloudflare-observability.yml', root),
    'utf8',
  );

  assert.match(workflow, /^\s{2}push:/m);
  assert.match(workflow, /cron: "0 1 \* \* \*"/);
  assert.doesNotMatch(workflow, /cron: "37 \* \* \* \*"/);
  assert.match(workflow, /^\s{2}issues: write$/m);
  assert.match(workflow, /^\s{2}statuses: write$/m);
  assert.match(workflow, /id: policy-self-test/);
  assert.match(workflow, /publish-cloudflare-observability-status\.mjs --self-test/);
  assert.match(workflow, /ACTIVE_WORKER_DEPLOYMENTS_OUTPUT: active-worker-deployments\.json/);
  assert.match(workflow, /active-worker-deployments\.json/);
  assert.match(workflow, /id: publish-status/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /OBSERVABILITY_TARGET_SHA:/);
  assert.match(workflow, /OBSERVABILITY_MAIN_REF: main/);
  assert.match(workflow, /steps\.policy-self-test\.outcome/);
  assert.match(workflow, /steps\.publish-status\.outcome == 'failure'/);
  assert.match(workflow, /cloudflare-observability-report-sh-/);
});
