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

function activeScripts() {
  return {
    'sh-buddies-ingest': {
      events: 1,
      retired: false,
      cpu_ms: { samples: 1, p95: 1, max: 1 },
    },
    'sh-minute-enrichment': {
      events: 1,
      retired: false,
      cpu_ms: { samples: 1, p95: 1, max: 1 },
    },
    'sh-sakurazaka46jp': {
      events: 1,
      retired: false,
      cpu_ms: { samples: 1, p95: 1, max: 1 },
    },
    'sh-runtime-orchestrator': {
      events: 1,
      retired: false,
      cpu_ms: { samples: 1, p95: 1, max: 1 },
    },
  };
}

function enforce(summary) {
  const directory = mkdtempSync(join(tmpdir(), 'sh-observability-'));
  const outputDirectory = join(directory, 'observability-logs');
  mkdirSync(outputDirectory);
  writeFileSync(join(outputDirectory, 'summary.json'), JSON.stringify(summary));
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, [enforcementScript], {
    cwd: directory,
    encoding: 'utf8',
  });
  const report = JSON.parse(readFileSync(
    join(outputDirectory, 'cpu-budget.json'),
    'utf8',
  ));
  rmSync(directory, { recursive: true, force: true });
  return { result, report };
}

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
  const scripts = {
    ...activeScripts(),
    'sh-monitor-other': {
      events: 1,
      retired: true,
      cpu_ms: { samples: 1, p95: 1, max: 1 },
    },
  };
  const { result, report } = enforce({
    events: 5,
    cpu_ms: { samples: 5 },
    scripts,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.violations.map(({ worker, reason }) => ({ worker, reason })),
    [{ worker: 'sh-monitor-other', reason: 'retired_worker_active' }],
  );
});

test('observability enforcement reports an idle active Worker without inventing a CPU violation', () => {
  const scripts = activeScripts();
  scripts['sh-buddies-ingest'] = {
    events: 0,
    retired: false,
    cpu_ms: { samples: 0, p95: null, max: null },
  };
  const { result, report } = enforce({
    events: 3,
    cpu_ms: { samples: 3 },
    scripts,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.ok, true);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.unobserved_active_workers, ['sh-buddies-ingest']);
});
