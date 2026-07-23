#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const STATUS_ISSUE_TITLE = 'Cloudflare Observability Status';
export const STATUS_MARKER = '<!-- cloudflare-observability-status -->';

const VALID_OUTCOMES = new Set(['success', 'failure', 'cancelled', 'skipped']);
const MAX_SECTION_CHARS = 12_000;
const MAX_ISSUE_BODY_CHARS = 60_000;

export function normalizeOutcome(value) {
  const outcome = String(value || '').trim().toLowerCase();
  return VALID_OUTCOMES.has(outcome) ? outcome : 'unknown';
}

export function statusState(outcome) {
  return normalizeOutcome(outcome) === 'success' ? 'success' : 'failure';
}

export function overallOutcome(outcomes) {
  return Object.values(outcomes).every((value) => normalizeOutcome(value) === 'success')
    ? 'success'
    : 'failure';
}

function clipped(text, maximum = MAX_SECTION_CHARS) {
  const value = String(text || '').trim();
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum)}\n\n…truncated…`;
}

async function readOptional(path) {
  try {
    return clipped(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function readOptionalJson(path) {
  const text = await readOptional(path);
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function section(title, body) {
  if (!body) return '';
  return `\n<details>\n<summary>${title}</summary>\n\n${body}\n\n</details>\n`;
}

function deploymentSummary(activeDeployments) {
  const entries = Object.entries(activeDeployments || {});
  const rows = entries.length
    ? entries.map(([worker, deployment]) => {
      const versions = Array.isArray(deployment?.version_ids)
        ? deployment.version_ids.join(', ')
        : String(deployment?.version_ids || 'unknown');
      return `| \`${worker}\` | \`${deployment?.deployment_id || 'unknown'}\` | \`${versions || 'unknown'}\` | ${deployment?.created_on || 'unknown'} |`;
    }).join('\n')
    : '| - | not captured | not captured | not captured |';
  return `### Active Worker deployments\n\n| Worker | Deployment | Traffic-bearing versions | Deployed at |\n|---|---|---|---|\n${rows}`;
}

function recentMergeSummary(recentMerges) {
  const rows = (Array.isArray(recentMerges) ? recentMerges : []).slice(0, 5).map((pull) => (
    `- #${pull.number} ${String(pull.title || '').replace(/\s+/g, ' ').trim()} (\`${pull.merge_commit_sha || 'unknown'}\`, ${pull.merged_at || 'unknown'})`
  ));
  return rows.length ? `### Recent merged changes on main\n\n${rows.join('\n')}` : '';
}

export function buildIssueBody({
  generatedAt,
  targetSha,
  mainSha = 'unknown',
  runUrl,
  trigger,
  outcomes,
  summaries = {},
  activeDeployments = {},
  recentMerges = [],
}) {
  const overall = overallOutcome(outcomes);
  const rows = Object.entries(outcomes)
    .map(([name, outcome]) => `| ${name} | ${normalizeOutcome(outcome)} |`)
    .join('\n');
  const body = `${STATUS_MARKER}
# Cloudflare Observability Status

This issue is maintained automatically by the Cloudflare Observability workflow.

- **Overall:** ${overall}
- **Generated:** ${generatedAt}
- **Trigger:** ${trigger}
- **Workflow source commit:** \`${targetSha}\`
- **Current main SHA:** \`${mainSha}\`
- **Workflow run:** ${runUrl}

${deploymentSummary(activeDeployments)}

${recentMergeSummary(recentMerges)}

| Gate | Outcome |
|---|---|
${rows}
${section('UTC daily request and D1 budgets', summaries.daily)}
${section('DO, Queues, R2, KV, and Pipelines budgets', summaries.freeTier)}
${section('Budget contract', summaries.contract)}
${section('Cloudflare metrics and live diagnostics', summaries.observability)}
`;
  return clipped(body, MAX_ISSUE_BODY_CHARS);
}

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function githubRequest(method, path, payload) {
  const repository = requiredEnv('GITHUB_REPOSITORY');
  const token = requiredEnv('GITHUB_TOKEN');
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'sh-cloudflare-observability-status',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: payload == null ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text.slice(0, 500) };
    }
  }
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${path} failed: ${response.status} ${text.slice(0, 500)}`);
  }
  return body;
}

async function publishCommitStatuses(targetSha, runUrl, outcomes) {
  const contexts = {
    policy: 'observability/policy-self-test',
    daily: 'observability/daily-d1-budget',
    freeTier: 'observability/free-tier-budget',
    contract: 'observability/budget-contract',
    query: 'observability/query',
    telemetry: 'observability/telemetry',
  };
  for (const [key, context] of Object.entries(contexts)) {
    const outcome = normalizeOutcome(outcomes[key]);
    await githubRequest('POST', `/statuses/${encodeURIComponent(targetSha)}`, {
      state: statusState(outcome),
      context,
      description: `${key}: ${outcome}`.slice(0, 140),
      target_url: runUrl,
    });
  }
  const overall = overallOutcome(outcomes);
  await githubRequest('POST', `/statuses/${encodeURIComponent(targetSha)}`, {
    state: overall,
    context: 'observability/overall',
    description: `Cloudflare observability: ${overall}`,
    target_url: runUrl,
  });
}

async function upsertStatusIssue(body) {
  const issues = await githubRequest('GET', '/issues?state=all&per_page=100&sort=updated&direction=desc');
  const existing = issues.find((issue) => (
    !issue.pull_request
    && issue.title === STATUS_ISSUE_TITLE
    && String(issue.body || '').includes(STATUS_MARKER)
  ));
  if (existing) {
    return githubRequest('PATCH', `/issues/${existing.number}`, {
      title: STATUS_ISSUE_TITLE,
      body,
      state: 'open',
    });
  }
  return githubRequest('POST', '/issues', {
    title: STATUS_ISSUE_TITLE,
    body,
  });
}

async function currentMainSha() {
  const mainRef = String(process.env.OBSERVABILITY_MAIN_REF || 'main').trim() || 'main';
  try {
    const commit = await githubRequest('GET', `/commits/${encodeURIComponent(mainRef)}`);
    return String(commit?.sha || 'unknown');
  } catch {
    return 'unknown';
  }
}

async function recentMergedPullRequests() {
  try {
    const pulls = await githubRequest('GET', '/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=20');
    return (Array.isArray(pulls) ? pulls : [])
      .filter((pull) => pull?.merged_at)
      .slice(0, 5)
      .map((pull) => ({
        number: pull.number,
        title: pull.title,
        merge_commit_sha: pull.merge_commit_sha,
        merged_at: pull.merged_at,
      }));
  } catch {
    return [];
  }
}

export async function publishFromEnvironment() {
  const targetSha = requiredEnv('OBSERVABILITY_TARGET_SHA');
  const runUrl = requiredEnv('OBSERVABILITY_RUN_URL');
  const outcomes = {
    policy: process.env.POLICY_OUTCOME,
    daily: process.env.DAILY_BUDGET_OUTCOME,
    freeTier: process.env.FREE_TIER_BUDGET_OUTCOME,
    contract: process.env.BUDGET_CONTRACT_OUTCOME,
    query: process.env.OBSERVABILITY_QUERY_OUTCOME,
    telemetry: process.env.TELEMETRY_POLICY_OUTCOME,
  };
  const [mainSha, activeDeployments, recentMerges, daily, freeTier, contract, observability] = await Promise.all([
    currentMainSha(),
    readOptionalJson('active-worker-deployments.json'),
    recentMergedPullRequests(),
    readOptional('daily-usage/summary.md'),
    readOptional('free-tier-usage/summary.md'),
    readOptional('observability-gate/summary.md'),
    readOptional('observability-summary.md'),
  ]);
  const body = buildIssueBody({
    generatedAt: new Date().toISOString(),
    targetSha,
    mainSha,
    runUrl,
    trigger: process.env.OBSERVABILITY_TRIGGER || 'unknown',
    outcomes,
    summaries: { daily, freeTier, contract, observability },
    activeDeployments,
    recentMerges,
  });
  await publishCommitStatuses(targetSha, runUrl, outcomes);
  const issue = await upsertStatusIssue(body);
  console.log(`Published observability status to issue #${issue.number}`);
}

function selfTest() {
  assert.equal(statusState('success'), 'success');
  assert.equal(statusState('skipped'), 'failure');
  assert.equal(overallOutcome({ a: 'success', b: 'success' }), 'success');
  assert.equal(overallOutcome({ a: 'success', b: 'failure' }), 'failure');
  const body = buildIssueBody({
    generatedAt: '2026-07-23T00:00:00.000Z',
    targetSha: 'abc123',
    mainSha: 'def456',
    runUrl: 'https://github.com/tarematsu/SH/actions/runs/1',
    trigger: 'workflow_run',
    outcomes: { policy: 'success', daily: 'failure' },
    summaries: { daily: '## Daily\n\n| Metric | Value |\n|---|---:|\n| D1 | 1 |' },
    activeDeployments: {
      worker: {
        deployment_id: 'deployment-1',
        version_ids: ['version-1'],
        created_on: '2026-07-23T00:00:00Z',
      },
    },
    recentMerges: [{
      number: 591,
      title: 'Deploy runtime after migrations',
      merge_commit_sha: 'merge591',
      merged_at: '2026-07-23T00:01:00Z',
    }],
  });
  assert.match(body, /Cloudflare Observability Status/);
  assert.match(body, /\| daily \| failure \|/);
  assert.match(body, /Workflow source commit:\*\* `abc123`/);
  assert.match(body, /Current main SHA:\*\* `def456`/);
  assert.match(body, /deployment-1/);
  assert.match(body, /#591/);
  assert.match(body, /UTC daily request and D1 budgets/);
  console.log('observability status publisher self-test passed');
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publishFromEnvironment().catch((error) => {
    console.error(`::error title=Publish observability status::${String(error?.message || error).replaceAll('\n', ' ').slice(0, 1000)}`);
    process.exitCode = 1;
  });
}
