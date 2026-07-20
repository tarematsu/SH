import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
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

test('rolling-hour D1 usage at 50 percent fails', () => {
  withTempDirectory((directory) => {
    const outputDirectory = join(directory, 'd1-usage');
    mkdirSync(outputDirectory);
    writeFileSync(join(outputDirectory, 'hourly-summary.json'), JSON.stringify({
      observed: { rowsRead: 500, rowsWritten: 49 },
      limits: { targetPerHour: { rowsRead: 500, rowsWritten: 50 } },
    }));
    const result = spawnSync(process.execPath, [hourlyScript], {
      cwd: directory,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rows read 500 >= 500/);
  });
});
