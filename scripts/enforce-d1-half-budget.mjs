import { readFileSync } from 'node:fs';

const reportPath = process.env.D1_USAGE_REPORT || 'd1-usage/summary.json';
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const ratio = 0.5;
const free = report?.limits?.free || {};
const actual = report?.planningEstimate || report?.latestComplete || {};
const target = {
  rowsRead: Number(free.rowsRead || 0) * ratio,
  rowsWritten: Number(free.rowsWritten || 0) * ratio,
};
const violations = [];

for (const [key, label] of [['rowsRead', 'rows read'], ['rowsWritten', 'rows written']]) {
  const value = Number(actual[key] || 0);
  const limit = Number(target[key] || 0);
  if (!limit) violations.push(`${label} free-tier limit is missing`);
  else if (value > limit) violations.push(`${label} ${value} > ${limit}`);
}

const result = {
  ok: violations.length === 0,
  ratio,
  source: report?.planningEstimate ? 'planningEstimate' : 'latestComplete',
  actual: {
    rowsRead: Number(actual.rowsRead || 0),
    rowsWritten: Number(actual.rowsWritten || 0),
  },
  target,
  violations,
};
console.log(JSON.stringify(result));

if (violations.length) {
  console.error(`D1 50% free-tier budget exceeded: ${violations.join(', ')}`);
  process.exit(1);
}
