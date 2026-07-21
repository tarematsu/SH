import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const enforcementScript = fileURLToPath(
  new URL('../.github/scripts/enforce-worker-cpu-budget.py', import.meta.url),
);

function runBudget(summary) {
  const directory = mkdtempSync(join(tmpdir(), 'sh-cpu-budget-'));
  const outputDirectory = join(directory, 'observability-logs');
  mkdirSync(outputDirectory);
  writeFileSync(join(outputDirectory, 'summary.json'), JSON.stringify(summary));

  try {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const result = spawnSync(python, [enforcementScript], {
      cwd: directory,
      encoding: 'utf8',
    });
    const report = JSON.parse(readFileSync(
      join(outputDirectory, 'cpu-budget.json'),
      'utf8',
    ));
    return { result, report };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function sampledWorker(maximum = 1) {
  return {
    events: 1,
    retired: false,
    cpu_ms: { samples: 1, p95: maximum, max: maximum },
  };
}

function summaryFor(maximum, { events = 1, samples = events } = {}) {
  return {
    events: events + 3,
    cpu_ms: { samples: samples + 3 },
    scripts: {
      'sh-buddies-ingest': sampledWorker(),
      'sh-minute-enrichment': sampledWorker(),
      'sh-sakurazaka46jp': sampledWorker(),
      'sh-runtime-orchestrator': {
        events,
        retired: false,
        cpu_ms: { samples, p95: maximum, max: maximum },
      },
    },
  };
}

test('10 ms is accepted as the inclusive per-invocation CPU ceiling', () => {
  const { result, report } = runBudget(summaryFor(10));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.ok, true);
  assert.equal(report.comparison, 'less_than_or_equal');
  assert.equal(report.statistic, 'max');
  assert.equal(report.workers['sh-runtime-orchestrator'].max_within_budget, true);
});

test('one invocation above 10 ms fails even when p95 is below the ceiling', () => {
  const summary = summaryFor(10.001);
  summary.scripts['sh-runtime-orchestrator'].cpu_ms.p95 = 4;
  const { result, report } = runBudget(summary);
  assert.equal(result.status, 1);
  assert.deepEqual(report.violations.map(({ reason }) => reason), ['invocation_above_budget']);
});

test('an invocation without a CPU sample fails the budget', () => {
  const { result, report } = runBudget(summaryFor(4, { events: 2, samples: 1 }));
  assert.equal(result.status, 1);
  assert.deepEqual(report.violations.map(({ reason }) => reason), ['incomplete_cpu_samples']);
});
