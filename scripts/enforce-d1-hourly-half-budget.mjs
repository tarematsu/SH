import { readFileSync } from 'node:fs';

const report = JSON.parse(readFileSync('d1-usage/hourly-summary.json', 'utf8'));
const observed = report.observed || {};
const target = report.limits?.targetPerHour || {};
const violations = [];

if (Number(observed.rowsRead || 0) >= Number(target.rowsRead || 0)) {
  violations.push(`rows read ${observed.rowsRead} >= ${Math.floor(target.rowsRead)}`);
}
if (Number(observed.rowsWritten || 0) >= Number(target.rowsWritten || 0)) {
  violations.push(`rows written ${observed.rowsWritten} >= ${Math.floor(target.rowsWritten)}`);
}

if (violations.length) {
  console.error(`D1 rolling-hour 50% budget exceeded: ${violations.join(', ')}`);
  process.exit(1);
}
console.log(`D1 rolling-hour 50% budget passed: ${observed.rowsRead} reads, ${observed.rowsWritten} writes`);
