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

const workflow = readFileSync(
  new URL('../.github/workflows/cloudflare-pr-diagnostics.yml', import.meta.url),
  'utf8',
);
const observability = readFileSync(
  new URL('../.github/workflows/fetch-cloudflare-observability.yml', import.meta.url),
  'utf8',
);
const observabilityAnalyzer = readFileSync(
  new URL('../.github/scripts/analyze-worker-observability.py', import.meta.url),
  'utf8',
);
const enforcementScript = fileURLToPath(
  new URL('../.github/scripts/enforce-worker-cpu-budget.py', import.meta.url),
);

test('direct PR deploys do not launch a second Cloudflare build watcher', () => {
  assert.match(workflow, /always\(\)/);
  assert.match(workflow, /needs\.select-workers\.outputs\.topology_rename == 'true'/);
  assert.match(workflow, /needs\.select-workers\.outputs\.diagnostics != '\[\]'/);
  assert.doesNotMatch(workflow, /needs\.prepare-workers\.result == 'success'/);
  assert.doesNotMatch(workflow, /direct PR deploy already succeeded/);
});

test('topology renames keep strict external build verification', () => {
  assert.match(workflow, /Skipping direct PR deploy because a Worker script name changed/);
  assert.match(workflow, /run: node \.github\/scripts\/cloudflare-build-diagnostics\.mjs/);
  assert.doesNotMatch(workflow, /status=\$\?/);
  assert.doesNotMatch(workflow, /exit 0/);
});

test('observability extraction uses the dedicated strict analyzer', () => {
  assert.match(observability, /python3 \.github\/scripts\/analyze-worker-observability\.py/);
  assert.match(observabilityAnalyzer, /for event in iter_events\(raw_dir\):/);
  assert.match(observabilityAnalyzer, /event_failure\(event\)/);
  assert.match(observabilityAnalyzer, /NON_FAILURE_OUTCOMES = \{"ok", "canceled"\}/);
  assert.match(observabilityAnalyzer, /event\.get\("CPUTimeMs"\)/);
  assert.match(observabilityAnalyzer, /return 0 if ok else 1/);
  assert.doesNotMatch(observability, /def event_metrics\(event\):/);
});

test('observability enforcement rejects events from retired Workers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sh-observability-'));
  const outputDirectory = join(directory, 'observability-logs');
  mkdirSync(outputDirectory);
  writeFileSync(join(outputDirectory, 'summary.json'), JSON.stringify({
    events: 2,
    cpu_ms: { samples: 2 },
    scripts: {
      'sh-runtime-orchestrator': {
        events: 1,
        retired: false,
        cpu_ms: { samples: 1, p95: 1, max: 1 },
      },
      'sh-monitor-other': {
        events: 1,
        retired: true,
        cpu_ms: { samples: 1, p95: 1, max: 1 },
      },
    },
  }));

  try {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const result = spawnSync(python, [enforcementScript], {
      cwd: directory,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(readFileSync(
      join(outputDirectory, 'cpu-budget.json'),
      'utf8',
    ));
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.violations.map(({ worker, reason }) => ({ worker, reason })),
      [{ worker: 'sh-monitor-other', reason: 'retired_worker_active' }],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
