import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
const dailyPath = '.github/scripts/audit-cloudflare-daily-usage.py';
const freeTierPath = '.github/scripts/audit-cloudflare-free-tier.py';
const daily = readFileSync(new URL(`../${dailyPath}`, import.meta.url), 'utf8');
const freeTier = readFileSync(new URL(`../${freeTierPath}`, import.meta.url), 'utf8');

function runSelfTest(path) {
  const result = spawnSync('python3', [path, '--self-test'], {
    cwd: rootPath,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${path}\n${result.stdout}\n${result.stderr}`);
}

test('partial UTC-day budget audits pass executable projection tests', () => {
  runSelfTest(dailyPath);
  runSelfTest(freeTierPath);
});

test('daily Worker and D1 gates use 24-hour projected values', () => {
  assert.match(daily, /PROJECTION_METHOD = "linear-from-utc-midnight"/);
  assert.match(daily, /DAY_SECONDS \/ elapsed/);
  assert.match(daily, /"actualUsage": actual/);
  assert.match(daily, /"usageKind": "projected-24h"/);
  assert.match(daily, /usage = project_usage\(actual, projection\)/);
  assert.match(daily, /violations = evaluate\(usage, LIMITS\)/);
  assert.match(daily, /Actual to date \| 24h projection/);
  assert.match(daily, /projected24h=/);
});

test('account-wide gate projects only daily allowance meters', () => {
  for (const metric of [
    'queueOperations',
    'doRequests',
    'doActiveGbSeconds',
    'doRowsRead',
    'doRowsWritten',
    'kvReads',
    'kvWrites',
    'kvDeletes',
    'kvLists',
  ]) {
    assert.match(freeTier, new RegExp(`"${metric}"`));
  }
  assert.match(freeTier, /_MONTHLY_OR_STATE_METRICS/);
  assert.match(freeTier, /project_daily_allowances\(actual, projection\)/);
  assert.match(freeTier, /"actualUsage": actual/);
  assert.match(freeTier, /mixed-daily-projection-and-period-actual/);
  assert.match(freeTier, /Daily meters: projected from 00:00 UTC to 24 hours/);
  assert.match(freeTier, /Monthly and storage meters: unprojected observed values/);
  assert.match(freeTier, /for key in _MONTHLY_OR_STATE_METRICS:/);
  assert.match(freeTier, /assert projected\[key\] == actual\[key\]/);
});
