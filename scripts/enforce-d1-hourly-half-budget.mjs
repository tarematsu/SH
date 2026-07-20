import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const reportPath = 'd1-usage/hourly-summary.json';
const report = JSON.parse(readFileSync(reportPath, 'utf8'));

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ceilQuarterHour(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const interval = 15 * 60_000;
  return new Date(Math.ceil(date.getTime() / interval) * interval);
}

function effectiveWindow(input) {
  const start = ceilQuarterHour(input?.window?.start);
  const end = new Date(input?.window?.end || input?.generatedAt || Date.now());
  const buckets = Array.isArray(input?.buckets) ? input.buckets : [];
  if (!start || !Number.isFinite(end.getTime()) || end <= start || !buckets.length) return null;
  const observed = { rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0 };
  for (const bucket of buckets) {
    const bucketAt = new Date(bucket?.bucket);
    if (!Number.isFinite(bucketAt.getTime()) || bucketAt < start || bucketAt > end) continue;
    observed.rowsRead += numeric(bucket.rowsRead);
    observed.rowsWritten += numeric(bucket.rowsWritten);
    observed.readQueries += numeric(bucket.readQueries);
    observed.writeQueries += numeric(bucket.writeQueries);
  }
  const minutes = Math.max(1 / 60, (end.getTime() - start.getTime()) / 60_000);
  const free = input?.limits?.freePerDay || {};
  const ratio = numeric(input?.limits?.targetRatio) || 0.5;
  const target = {
    rowsRead: numeric(free.rowsRead) * ratio * minutes / (24 * 60),
    rowsWritten: numeric(free.rowsWritten) * ratio * minutes / (24 * 60),
  };
  if (!target.rowsRead || !target.rowsWritten) return null;
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    minutes,
    observed,
    target,
  };
}

const effective = effectiveWindow(report);
const observed = effective?.observed || report.observed || {};
const target = effective?.target
  || report.limits?.targetPerWindow
  || report.limits?.targetPerHour
  || {};
const violations = [];

if (numeric(observed.rowsRead) >= numeric(target.rowsRead)) {
  violations.push(`rows read ${observed.rowsRead} >= ${Math.floor(target.rowsRead)}`);
}
if (numeric(observed.rowsWritten) >= numeric(target.rowsWritten)) {
  violations.push(`rows written ${observed.rowsWritten} >= ${Math.floor(target.rowsWritten)}`);
}

const gate = {
  ok: violations.length === 0,
  comparison: 'less_than',
  scope: effective ? 'post-deploy-complete-buckets' : 'reported-window',
  window: effective ? {
    start: effective.start,
    end: effective.end,
    minutes: effective.minutes,
  } : report.window,
  observed,
  target,
  violations,
};
report.budgetGate = gate;
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

const summary = [
  '',
  '## Effective post-deploy D1 gate',
  '',
  `- Scope: \`${gate.scope}\``,
  `- Window: \`${gate.window?.start}\` to \`${gate.window?.end}\``,
  `- Rows read: \`${numeric(observed.rowsRead)}\` / \`< ${Math.floor(numeric(target.rowsRead))}\``,
  `- Rows written: \`${numeric(observed.rowsWritten)}\` / \`< ${Math.floor(numeric(target.rowsWritten))}\``,
  `- Result: **${gate.ok ? 'PASS' : 'FAIL'}**`,
  '',
].join('\n');
appendFileSync('d1-usage/hourly-summary.md', summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);

if (violations.length) {
  console.error(`D1 rolling-window 50% budget exceeded: ${violations.join(', ')}`);
  process.exit(1);
}
console.log(`D1 rolling-window 50% budget passed: ${observed.rowsRead} reads, ${observed.rowsWritten} writes`);
