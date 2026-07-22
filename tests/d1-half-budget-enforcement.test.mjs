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

const dailyScript = fileURLToPath(
  new URL('../scripts/enforce-d1-half-budget.mjs', import.meta.url),
);
const hourlyScript = fileURLToPath(
  new URL('../scripts/enforce-d1-hourly-half-budget.mjs', import.meta.url),
);

function withTempDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), 'sh-d1-budget-'));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runHourly(directory, report) {
  const outputDirectory = join(directory, 'd1-usage');
  mkdirSync(outputDirectory);
  writeFileSync(join(outputDirectory, 'hourly-summary.json'), JSON.stringify(report));
  const result = spawnSync(process.execPath, [hourlyScript], {
    cwd: directory,
    encoding: 'utf8',
  });
  const updated = JSON.parse(readFileSync(join(outputDirectory, 'hourly-summary.json'), 'utf8'));
  return { result, updated };
}

test('daily D1 planning usage must stay strictly below 50 percent', () => {
  withTempDirectory((directory) => {
    const reportPath = join(directory, 'summary.json');
    writeFileSync(reportPath, JSON.stringify({
      limits: { free: { rowsRead: 1_000, rowsWritten: 100 } },
      planningEstimate: { rowsRead: 500, rowsWritten: 49 },
    }));
    const result = spawnSync(process.execPath, [dailyScript], {
      cwd: directory,
      env: { ...process.env, D1_USAGE_REPORT: reportPath },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rows read 500 >= 500/);
  });
});

test('daily D1 planning usage below 50 percent passes', () => {
  withTempDirectory((directory) => {
    const reportPath = join(directory, 'summary.json');
    writeFileSync(reportPath, JSON.stringify({
      limits: { free: { rowsRead: 1_000, rowsWritten: 100 } },
      planningEstimate: { rowsRead: 499, rowsWritten: 49 },
    }));
    const result = spawnSync(process.execPath, [dailyScript], {
      cwd: directory,
      env: { ...process.env, D1_USAGE_REPORT: reportPath },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  });
});

test('reported rolling-window D1 usage at 50 percent fails', () => {
  withTempDirectory((directory) => {
    const { result } = runHourly(directory, {
      observed: { rowsRead: 500, rowsWritten: 49 },
      limits: { targetPerWindow: { rowsRead: 500, rowsWritten: 50 } },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rows read 500 >= 500/);
  });
});

test('reported rolling-window D1 usage below 50 percent passes', () => {
  withTempDirectory((directory) => {
    const { result } = runHourly(directory, {
      observed: { rowsRead: 499, rowsWritten: 49 },
      limits: { targetPerWindow: { rowsRead: 500, rowsWritten: 50 } },
    });
    assert.equal(result.status, 0, result.stderr);
  });
});

test('post-deploy writes use the hourly allowance while reads stay window-proportional', () => {
  withTempDirectory((directory) => {
    const { result, updated } = runHourly(directory, {
      generatedAt: '2026-07-22T00:20:00.000Z',
      window: {
        start: '2026-07-22T00:14:00.000Z',
        end: '2026-07-22T00:20:00.000Z',
      },
      limits: {
        freePerDay: { rowsRead: 5_000_000, rowsWritten: 100_000 },
        targetRatio: 0.5,
        targetPerHour: { rowsRead: 104_166.67, rowsWritten: 2_083.33 },
      },
      buckets: [{
        bucket: '2026-07-22T00:15:00.000Z',
        rowsRead: 8_000,
        rowsWritten: 258,
        readQueries: 10,
        writeQueries: 20,
      }],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(updated.budgetGate.targetBasis.rowsRead, 'measured-window');
    assert.equal(updated.budgetGate.targetBasis.rowsWritten, 'hourly-burst-allowance');
    assert.equal(Math.floor(updated.budgetGate.target.rowsRead), 8_680);
    assert.equal(Math.floor(updated.budgetGate.target.rowsWritten), 2_083);
  });
});

test('post-deploy full scans still fail the proportional read allowance', () => {
  withTempDirectory((directory) => {
    const { result } = runHourly(directory, {
      generatedAt: '2026-07-22T00:20:00.000Z',
      window: {
        start: '2026-07-22T00:14:00.000Z',
        end: '2026-07-22T00:20:00.000Z',
      },
      limits: {
        freePerDay: { rowsRead: 5_000_000, rowsWritten: 100_000 },
        targetRatio: 0.5,
      },
      buckets: [{
        bucket: '2026-07-22T00:15:00.000Z',
        rowsRead: 2_300_000,
        rowsWritten: 258,
      }],
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rows read 2300000 >= 8680/);
  });
});

test('post-deploy writes at the hourly allowance fail strictly', () => {
  withTempDirectory((directory) => {
    const { result } = runHourly(directory, {
      generatedAt: '2026-07-22T00:20:00.000Z',
      window: {
        start: '2026-07-22T00:14:00.000Z',
        end: '2026-07-22T00:20:00.000Z',
      },
      limits: {
        freePerDay: { rowsRead: 5_000_000, rowsWritten: 100_000 },
        targetRatio: 0.5,
      },
      buckets: [{
        bucket: '2026-07-22T00:15:00.000Z',
        rowsRead: 1,
        rowsWritten: 2_084,
      }],
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rows written 2084 >= 2083/);
  });
});
